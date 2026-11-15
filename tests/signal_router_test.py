# Public DNS IPs below are numeric fixtures only; tests never connect to them.
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'signal-router'))
from router import create_app, route_answer, relay_offer, PROTECTED, validate_config

CONFIG = {'sourceUdpIP': '8.8.8.8', 'sourceUdpPort': 34051,
          'publicUdpIP': '1.1.1.1', 'publicUdpPort': 32592,
          'routeName': 'japan', 'relayOnly': True}
SDP = ('v=0\r\ns=-\r\na=identity:opaque-signed-identity\r\n'
       'm=application 34051 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 8.8.8.8\r\n'
       'a=ice-ufrag:serverUfrag\r\na=ice-pwd:unchangedPassword\r\n'
       'a=fingerprint:sha-256 AA:BB:CC\r\n'
       'a=candidate:123 1 udp 2122260223 8.8.8.8 34051 typ host generation 0\r\n'
       'a=candidate:124 1 udp 123456789 192.168.1.20 19132 typ host\r\n'
       'a=end-of-candidates\r\n').encode()


class RewriteTests(unittest.TestCase):
    def test_any_route_name_endpoint_and_local_port_are_supported(self):
        config = dict(CONFIG, routeName='备用线路', listenIP='127.0.0.1', listenPort=29301,
                      upstream='http://127.0.0.1:29431', publicUdpIP='9.9.9.9', publicUdpPort=40123)
        validate_config(config)
        answer, changed = route_answer(SDP, config)
        self.assertTrue(changed)
        self.assertIn(b'9.9.9.9 40123 typ host', answer)
        self.assertNotIn(b'1.1.1.1', answer)

    def test_config_rejects_remote_upstream_and_port_collision(self):
        config = dict(CONFIG, listenIP='127.0.0.1', listenPort=29301, upstream='http://example.com:19132')
        with self.assertRaises(ValueError): validate_config(config)
        config['upstream'] = 'http://127.0.0.1:29301'
        with self.assertRaises(ValueError): validate_config(config)

    def test_only_japan_candidate_remains_and_identity_is_unchanged(self):
        answer, changed = route_answer(SDP, CONFIG)
        self.assertTrue(changed)
        self.assertIn(b'1.1.1.1 32592 typ host', answer)
        self.assertNotIn(b'8.8.8.8', answer)
        self.assertNotIn(b'192.168.1.20', answer)
        self.assertEqual(answer.count(b'a=candidate:'), 1)
        for prefix in PROTECTED:
            old = [line for line in SDP.splitlines() if line.startswith(prefix.encode())]
            new = [line for line in answer.splitlines() if line.startswith(prefix.encode())]
            self.assertEqual(old, new)

    def test_upstream_identity_rejection_is_not_mistaken_for_success(self):
        self.assertEqual(route_answer(b'37', CONFIG), (b'37', False))

    def test_unexpected_backend_endpoint_fails_instead_of_silently_using_domestic(self):
        with self.assertRaises(ValueError):
            route_answer(SDP.replace(b'8.8.8.8', b'1.2.3.4'), CONFIG)

    def test_offer_keeps_identity_but_prevents_backend_direct_connection(self):
        body = relay_offer(SDP)
        self.assertIn(b'192.0.2.1 9 typ host', body)
        self.assertEqual(body.count(b'a=candidate:'), 1)
        self.assertIn(b'a=identity:opaque-signed-identity\r\n', body)

    def test_explicit_local_endpoint_supports_new_core_without_arbitrary_fallback(self):
        config = dict(CONFIG, localUdpIP='192.168.1.20', localUdpPort=19132)
        answer, changed = route_answer(SDP.replace(b'8.8.8.8', b'1.2.3.4'), config)
        self.assertTrue(changed)
        self.assertEqual(answer.count(b'a=candidate:'), 1)
        self.assertNotIn(b'192.168.1.20', answer)
        self.assertIn(b'1.1.1.1 32592 typ host', answer)

    def test_offer_before_candidate_gathering_stays_unchanged(self):
        offer = b'v=0\r\na=ice-ufrag:unchanged\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
        self.assertEqual(relay_offer(offer), offer)


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.received = []
        async def upstream(request):
            self.received.append(await request.read())
            if request.method == 'GET':
                return web.json_response({'name': 'same-world', 'maxPlayers': 20})
            return web.Response(body=SDP, content_type='application/sdp')
        backend = web.Application()
        backend.router.add_route('*', '/{path:.*}', upstream)
        self.backend = TestServer(backend)
        await self.backend.start_server()
        config = dict(CONFIG, upstream=str(self.backend.make_url('')).rstrip('/'))
        self.client = TestClient(TestServer(create_app(config)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.backend.close()

    async def test_metadata_is_forwarded_without_becoming_another_world(self):
        response = await self.client.get('/v1/join')
        self.assertEqual((await response.json())['name'], 'same-world')

    async def test_twenty_parallel_offers_keep_route_and_authentication_separate(self):
        import asyncio
        async def one(number):
            response = await self.client.post('/v1/join/' + str(number), data=SDP,
                                              headers={'Content-Type': 'application/sdp'})
            body = await response.read()
            self.assertEqual(response.status, 200)
            self.assertIn(b'1.1.1.1 32592', body)
            self.assertIn(b'a=identity:opaque-signed-identity', body)
        await asyncio.gather(*(one(number) for number in range(20)))
        self.assertEqual(len(self.received), 20)
        self.assertTrue(all(b'192.0.2.1 9 typ host' in body for body in self.received))


if __name__ == '__main__':
    unittest.main()
