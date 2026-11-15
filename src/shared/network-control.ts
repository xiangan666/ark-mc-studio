import { z } from "zod";

export const signalRouterSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((v) => !/[\r\n]/.test(v)),
  signalId: z.number().int().positive(),
  udpId: z.number().int().positive(),
  enabled: z.boolean(),
  listenIP: z.literal("127.0.0.1"),
  listenPort: z.number().int().min(1024).max(65535),
  upstream: z.string().url().max(200),
  sourceUdpIP: z.ipv4(),
  sourceUdpPort: z.number().int().min(1).max(65535),
  publicUdpIP: z.ipv4(),
  publicUdpPort: z.number().int().min(1).max(65535),
  relayOnly: z.boolean(),
});
export const networkControlSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("tunnels.get"),
    args: z.object({ id: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("tunnels.action"),
    args: z.object({
      id: z.string().uuid(),
      action: z.enum(["start", "stop", "reload"]),
      tunnelId: z.number().int().positive().optional(),
    }),
  }),
  z.object({
    method: z.literal("routers.save"),
    args: z.object({ id: z.string().uuid(), config: signalRouterSchema }),
  }),
  z.object({
    method: z.literal("tools.list"),
    args: z.object({ check: z.boolean().default(false) }),
  }),
  z.object({
    method: z.literal("tools.install"),
    args: z.object({ tool: z.enum(["lolia", "sakura", "frp", "uv"]) }),
  }),
  z.object({ method: z.literal("tools.router-runtime"), args: z.object({}) }),
  z.object({
    method: z.literal("tools.organize"),
    args: z.object({
      id: z.string().uuid(),
      source: z.string().min(3).max(2000).optional(),
    }),
  }),
  z.object({
    method: z.literal("tunnels.attach"),
    args: z.object({
      id: z.string().uuid(),
      root: z.string().min(3).max(2000),
    }),
  }),
  z.object({
    method: z.literal("tunnels.prepare"),
    args: z.object({ id: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("tunnels.import"),
    args: z.object({
      id: z.string().uuid(),
      provider: z.enum(["lolia", "sakura", "frp-panel"]).default("lolia"),
      tunnelId: z.number().int().positive(),
      token: z.string().min(12).max(256),
    }),
  }),
  z.object({
    method: z.literal("tunnels.target"),
    args: z.object({
      id: z.string().uuid(),
      tunnelId: z.number().int().positive(),
      ip: z.ipv4(),
    }),
  }),
]);
export type NetworkControlRequest = z.infer<typeof networkControlSchema>;
export const networkControlMethods = new Set(
  networkControlSchema.options.map((s) => s.shape.method.value as string),
);
