import type { SystemAccountPurpose } from "../settings/dto/settings.schemas";
export type { SystemAccountPurpose };

export interface PostJournalLine {
  accountId?: number;
  systemPurpose?: SystemAccountPurpose;
  debit?: string;
  credit?: string;
  description?: string;
  clientId?: number;
  vendorId?: number;
  projectId?: number;
  departmentId?: string;
  employeeId?: number;
  taxCodeId?: number;
  dimensionValues?: Record<string, string>;
}

export interface PostJournalInput {
  entryDate: string;
  postingDate?: string;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceEvent: string;
  currency?: string;
  exchangeRate?: string;
  lines: PostJournalLine[];
  createdBy?: string;
}

export interface PostJournalResult {
  entryId: number;
  entryNumber: string;
  replayed: boolean;
}

export interface ReverseJournalResult {
  reversalEntryId: number;
}
