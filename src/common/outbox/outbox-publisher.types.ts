export interface OutboxFlushResult {
  claimed: number;
  delivered: number;
  suppressed: number;
  retried: number;
  dead: number;
  fenced: number;
}

export interface OutboxMetrics {
  pending: number;
  inFlight: number;
  dead: number;
  oldestPendingAt: Date | null;
}

export interface OutboxOrganizationReport {
  organizationId: string;
  totalRows: number;
  pending: number;
  inFlight: number;
  dead: number;
  oldestPendingAt: Date | null;
  oldestEventAt: Date | null;
  oldestEventAgeSeconds: number | null;
  distinctEventTypes: number;
}

export interface OutboxReport {
  generatedAt: string;
  organizations: number;
  succeeded: number;
  failed: number;
  reports: OutboxOrganizationReport[];
}
