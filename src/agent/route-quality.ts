import https from "node:https";
import http from "node:http";
import { performance } from "node:perf_hooks";
import type { Route, RouteQuality, RouteQualitySample } from "../shared/types";
import type { JobContext } from "./jobs";
import { errorText } from "./safe";

export function summarizeQuality(samples: RouteQualitySample[]) {
  const good = samples
    .filter((s) => s.ok)
    .map((s) => s.elapsedMs)
    .sort((a, b) => a - b);
  const successive = samples
    .slice(1)
    .flatMap((s, i) =>
      s.ok && samples[i].ok
        ? [Math.abs(s.elapsedMs - samples[i].elapsedMs)]
        : [],
    );
  return {
    failureRate: samples.length
      ? ((samples.length - good.length) / samples.length) * 100
      : 0,
    medianMs: good.length
      ? good.length % 2
        ? good[(good.length - 1) / 2]
        : (good[good.length / 2 - 1] + good[good.length / 2]) / 2
      : null,
    p95Ms: good.length ? good[Math.ceil(good.length * 0.95) - 1] : null,
    jitterMs: successive.length
      ? successive.reduce((a, b) => a + b, 0) / successive.length
      : null,
  };
}

export function recommendRoute(routes: RouteQuality[]) {
  return routes
    .filter(
      (r) =>
        r.transport.status === "pass" &&
        r.medianMs != null &&
        r.samples.some((s) => s.ok),
    )
    .sort(
      (a, b) =>
        a.failureRate - b.failureRate ||
        a.medianMs! + (a.jitterMs || 0) - (b.medianMs! + (b.jitterMs || 0)),
    )[0]?.signalId;
}

export async function signalSample(
  route: Route,
  signal: AbortSignal,
): Promise<RouteQualitySample> {
  const start = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const url = `${route.protocol || "https"}://${route.host}:${route.port}/v1/join`;
      const transport = route.protocol === "http" ? http : https;
      const request = transport.get(
        url,
        {
          agent: false,
          signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
          headers: {
            "User-Agent": "ArkMC-Studio/quality",
            "Cache-Control": "no-cache",
          },
        },
        (response) => {
          let length = 0;
          response.on("data", (chunk) => {
            length += chunk.length;
            if (length > 256 * 1024)
              request.destroy(new Error("信令响应超过检测大小限制"));
          });
          response.once("end", () =>
            response.statusCode === 200
              ? resolve()
              : reject(new Error(`HTTP ${response.statusCode}`)),
          );
          response.once("error", reject);
        },
      );
      request.once("error", reject);
    });
    return { ok: true, elapsedMs: Math.round(performance.now() - start) };
  } catch (error) {
    signal.throwIfAborted();
    return {
      ok: false,
      elapsedMs: Math.round(performance.now() - start),
      error: errorText(error),
    };
  }
}

export async function measureRouteQuality(
  route: Route,
  ctx: JobContext,
  probe: () => Promise<{ detail: string; connectMs?: number }>,
  progress: () => void,
  sample: typeof signalSample = signalSample,
): Promise<RouteQuality> {
  const samples: RouteQualitySample[] = [];
  for (let n = 0; n < 5; n++) {
    ctx.signal.throwIfAborted();
    samples.push(await sample(route, ctx.signal));
    progress();
  }
  let transport: RouteQuality["transport"] = {
    status: "skipped",
    detail: "信令请求全部失败，未执行传输握手",
  };
  if (samples.some((s) => s.ok)) {
    try {
      transport = { status: "pass", ...(await probe()) };
    } catch (error) {
      ctx.signal.throwIfAborted();
      transport = { status: "fail", detail: errorText(error) };
    }
  }
  progress();
  return {
    signalId: route.signalId,
    name: route.name,
    host: route.host,
    port: route.port,
    checkedAt: Date.now(),
    samples,
    ...summarizeQuality(samples),
    transport,
  };
}
