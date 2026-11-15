export interface WorkspaceUpgradeReport {
  version: string;
  checkedAt: number;
  status: "complete" | "attention";
  changes: string[];
  retained: string[];
  warnings: string[];
  removedBytes: number;
}
