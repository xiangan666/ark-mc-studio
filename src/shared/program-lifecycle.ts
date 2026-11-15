export interface ProgramPlan {
  id: string;
  name: string;
  root: string;
  server: boolean;
  tunnels: number[];
  direct: boolean;
}
export interface ProgramTransition {
  version: string;
  mode: "upgrade" | "quit";
  phase: "idle" | "running" | "complete" | "failed";
  progress: number;
  detail: string;
  plans: ProgramPlan[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
