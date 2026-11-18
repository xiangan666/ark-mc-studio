import { useSyncExternalStore } from "react";
import { useApp } from "./store";

const media = window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribe = (notify: () => void) => {
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const read = () => media.matches;

export function useMotionPreference() {
  const system = useSyncExternalStore(subscribe, read);
  const app = useApp((s) => s.data?.settings.reducedMotion);
  return system || !!app;
}
