/*
  The bulk-send pass's result and one source row as the mapper reads it.
  `sign-bulk-send.service.ts` re-exports `BulkProcessResult`.
*/

export interface BulkProcessResult {
  jobId: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
}

export interface MappedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  name?: string;
  email?: string;
  phone?: string;
  error?: string;
}
