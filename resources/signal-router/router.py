"""Configurable NetherNet signaling adapter for any managed network route.

Only UDP endpoint candidates are rewritten. Signed identities, fingerprints and
ICE credentials are preserved byte for byte. No SDP or credentials are logged.
"""
from pathlib import Path
import ipaddress
import json
import logging
import os
import re
import argparse
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, web

ROOT = Path(__file__).resolve().parent
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'}
PROTECTED = ('a=fingerprint:', 'a=identity:', 'a=ice-ufrag:', 'a=ice-pwd:')
LOGGER = logging.getLogger('mc-signal-router')
UPSTREAM_CLIENT = web.AppKey('upstream_client', ClientSession)


def lines_of(body):
    return body.decode('utf-8').replace('\r\n', '\n').split('\n')


def join_lines(lines, original):
    return ('\r\n' if b'\r\n' in original else '\n').join(lines).encode('utf-8')


def relay_offer(body):
    if not body.startswith(b'v='):
        return body
    original = lines_of(body)
    result, inserted = [], False
    for line in original:
        if line.startswith('a=candidate:'):
            parts = line.split()
            if not inserted and len(parts) >= 8 and parts[2].lower() == 'udp':
                parts[4:6] = ['192.0.2.1', '9']
                result.append(' '.join(parts))
                inserted = True
        elif line.startswith('m=application '):
            parts = line.split()
            parts[1] = '9'
            result.append(' '.join(parts))
        elif line.startswith('c='):
            result.append('c=IN IP4 192.0.2.1')
        else:
            result.append(line)
    # Some NetherNet clients send the initial offer before ICE candidates are
    # gathered. Forward that offer unchanged; the answer still carries the
    # server candidate that route_answer rewrites.
    if not inserted:
        return body
    assert [s for s in original if s.startswith(PROTECTED)] == [s for s in result if s.startswith(PROTECTED)]
    return join_lines(result, body)


def route_answer(body, config):
    if not body.startswith(b'v='):
        return body, False  # Preserve BDS rejection codes, including identity failures.
    original = lines_of(body)
    template = None
    for line in original:
        if not line.startswith('a=candidate:'):
            continue
        parts = line.split()
        if len(parts) >= 8 and parts[2].lower() == 'udp':
            endpoints = {(config['sourceUdpIP'], str(config['sourceUdpPort']))}
            if config.get('localUdpIP') and config.get('localUdpPort'):
                endpoints.add((config['localUdpIP'], str(config['localUdpPort'])))
            related = None
            if 'raddr' in parts and 'rport' in parts:
                related = (parts[parts.index('raddr') + 1], parts[parts.index('rport') + 1])
            if (parts[4], parts[5]) in endpoints or related in endpoints:
                template = parts
                break
    if template is None:
        raise ValueError('Core did not advertise a configured UDP endpoint')
    # Remove stale related-address fields rather than carrying another route's IP.
    template = template[:4] + [config['publicUdpIP'], str(config['publicUdpPort']), 'typ', 'host']
    result, inserted = [], False
    for line in original:
        if line.startswith('a=candidate:'):
            if not inserted:
                result.append(' '.join(template))
                inserted = True
        elif line.startswith('m=application '):
            parts = line.split()
            parts[1] = str(config['publicUdpPort'])
            result.append(' '.join(parts))
        elif line.startswith('c='):
            family = 'IP6' if ipaddress.ip_address(config['publicUdpIP']).version == 6 else 'IP4'
            result.append('c=IN ' + family + ' ' + config['publicUdpIP'])
        else:
            result.append(line)
    assert [s for s in original if s.startswith(PROTECTED)] == [s for s in result if s.startswith(PROTECTED)]
    return join_lines(result, body), True


def create_app(config):
    app = web.Application(client_max_size=1024 * 1024)

    async def client_context(_):
        session = ClientSession(timeout=ClientTimeout(total=40), trust_env=False)
        app[UPSTREAM_CLIENT] = session
        yield
        await session.close()

    app.cleanup_ctx.append(client_context)

    async def health(_):
        return web.json_response({'ok': True, 'route': config['routeName']})

    async def forward(request):
        if request.method not in ('GET', 'POST') or not re.fullmatch(r'/v1/join(?:/[0-9]+)?', request.path):
            raise web.HTTPNotFound()
        body = await request.read()
        is_offer = request.method == 'POST' and request.path != '/v1/join'
        try:
            if is_offer and config.get('relayOnly'):
                body = relay_offer(body)
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest(text='Invalid SDP offer')
        blocked = HOP_HEADERS | {'host', 'accept-encoding'}
        blocked.update(part.strip().lower() for part in request.headers.get('Connection', '').split(','))
        headers = {key: value for key, value in request.headers.items() if key.lower() not in blocked}
        headers['Accept-Encoding'] = 'identity'
        try:
            async with app[UPSTREAM_CLIENT].request(request.method, config['upstream'] + request.raw_path,
                    data=body if body else None, headers=headers, allow_redirects=False) as response:
                chunks, size = [], 0
                async for chunk in response.content.iter_chunked(65536):
                    size += len(chunk)
                    if size > 1024 * 1024:
                        raise ValueError('Upstream SDP response is too large')
                    chunks.append(chunk)
                result = b''.join(chunks)
                status = response.status
                response_blocked = HOP_HEADERS | {'content-encoding', 'etag'}
                response_blocked.update(part.strip().lower() for part in response.headers.get('Connection', '').split(','))
                outgoing = {key: value for key, value in response.headers.items()
                            if key.lower() not in response_blocked}
                rewritten = False
                if is_offer and status == 200:
                    result, rewritten = route_answer(result, config)
        except Exception as error:
            LOGGER.warning('route=%s upstream_failed=%s', config['routeName'], type(error).__name__)
            raise web.HTTPBadGateway(text='Signaling route unavailable')
        outgoing['Cache-Control'] = 'no-store'
        outgoing['X-MC-Route'] = config['routeName']
        LOGGER.info('route=%s method=%s status=%s sdp_rewritten=%s', config['routeName'], request.method, status, rewritten)
        return web.Response(status=status, headers=outgoing, body=result)

    app.router.add_get('/_health', health)
    app.router.add_route('*', '/{path:.*}', forward)
    return app


def validate_config(config):
    upstream = urlsplit(config['upstream'])
    if (not ipaddress.ip_address(config['listenIP']).is_loopback
            or upstream.scheme != 'http' or upstream.hostname not in ('127.0.0.1', 'localhost', '::1')
            or upstream.username or upstream.password or upstream.path not in ('', '/') or upstream.query or upstream.fragment):
        raise ValueError('Signaling listener and upstream must use local loopback interfaces')
    for key in ('listenPort', 'sourceUdpPort', 'publicUdpPort'):
        if type(config[key]) is not int or not 1 <= config[key] <= 65535:
            raise ValueError('Invalid signaling or UDP port')
    if upstream.port == config['listenPort'] and upstream.hostname == config['listenIP']:
        raise ValueError('Signaling upstream cannot point to itself')
    for name in ('sourceUdpIP', 'publicUdpIP'):
        if not ipaddress.ip_address(config[name]).is_global:
            raise ValueError('Mapped UDP endpoint must be a public IP address')
    if not isinstance(config.get('routeName'), str) or not config['routeName'].strip():
        raise ValueError('A route name is required')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--state', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
    validate_config(config)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    state = Path(args.state)
    state.write_text(json.dumps({'pid': os.getpid()}), encoding='utf-8')
    try:
        web.run_app(create_app(config), host=config['listenIP'], port=config['listenPort'], access_log=None)
    finally:
        if state.exists() and json.loads(state.read_text(encoding='utf-8'))['pid'] == os.getpid():
            state.unlink()
