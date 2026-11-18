import type { Job } from "./types";

// Keep the established recent window, plus any older jobs that can still block an instance.
export function jobWindow(jobs: Job[]) {
  return jobs
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .filter(
      (job, i) =>
        i < 150 || job.status === "running" || job.status === "queued",
    );
}
