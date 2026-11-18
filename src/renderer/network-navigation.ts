export type NetworkSection = "routes" | "signals" | "diagnostics" | "clients";
export const networkSections: { value: NetworkSection; label: string }[] = [
  { value: "routes", label: "玩家入口" },
  { value: "signals", label: "信令转接" },
  { value: "diagnostics", label: "检测结果" },
  { value: "clients", label: "客户端" },
];
export function networkSectionForTarget(target: string): NetworkSection | null {
  if (target === "network-signaling") return "signals";
  if (
    target === "network-diagnostics" ||
    target.startsWith("route-diagnostics-")
  )
    return "diagnostics";
  if (target === "network-clients") return "clients";
  return target === "network-routes" ||
    target === "network-attention" ||
    target.startsWith("route-")
    ? "routes"
    : null;
}
