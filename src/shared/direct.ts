export interface DirectRouteStatus {
  configured: boolean;
  enabled?: boolean;
  running?: boolean;
  ready?: boolean;
  name?: string;
  domain?: string;
  httpsPort?: number;
  udpPort?: number;
  publicIPv6?: string;
  certificateExpires?: string;
  certificateRenewal?: string;
  sessions?: number;
  receivedBytes?: number;
  sentBytes?: number;
  pid?: number;
  error?: string;
  ddns?: { ok: boolean; addresses: string[]; checkedAt: string };
  diagnostic?: DirectRouteReport;
}

export interface DirectRouteReport {
  checks: { name: string; ok: boolean; detail: string }[];
  testedAt: string;
  scope: string;
}
