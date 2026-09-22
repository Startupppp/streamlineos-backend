import { createHash } from "node:crypto";
import type { ImportFormat, ParsedSource } from "./import-source";
import {
  coerceImportValues,
  issueField,
  issueMessage,
  ticketImportRowSchema,
  type TicketImportRow,
} from "./dto/ticket-import.schemas";

type ImportIssueKind = "INVALID" | "DUPLICATE_IN_FILE" | "DUPLICATE_EXISTING";

export interface ImportRowIssue {
  rowNumber: number;
  field: string | null;
  kind: ImportIssueKind;
  message: string;
}

export interface ImportPreviewRow {
  rowNumber: number;
  values: TicketImportRow & { status: string };
}

interface ImportPreviewSummary {
  totalRows: number;
  importable: number;
  invalid: number;
  duplicateInFile: number;
  duplicateExisting: number;
}

export interface TicketImportPreview {
  format: ImportFormat;
  projectId: number;
  fileError: string | null;
  summary: ImportPreviewSummary;
  rows: ImportPreviewRow[];
  issues: ImportRowIssue[];
  confirmationToken: string | null;
}

export interface TicketImportPreviewInput {
  orgId: string;
  projectId: number;
  parsed: ParsedSource;
  allowedStatuses: readonly string[];
  existingTitleKeys: readonly string[];
}

export function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function emptySummary(totalRows: number): ImportPreviewSummary {
  return {
    totalRows,
    importable: 0,
    invalid: 0,
    duplicateInFile: 0,
    duplicateExisting: 0,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function confirmationTokenFor(
  orgId: string,
  projectId: number,
  rows: readonly ImportPreviewRow[],
): string {
  const payload = canonical({
    v: 1,
    orgId,
    projectId,
    rows: rows.map((row) => ({ rowNumber: row.rowNumber, values: row.values })),
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildTicketImportPreview(
  input: TicketImportPreviewInput,
): TicketImportPreview {
  const { parsed, projectId, orgId } = input;
  const base = {
    format: parsed.format,
    projectId,
    rows: [] as ImportPreviewRow[],
    confirmationToken: null,
  };

  if (parsed.fileError)
    return { ...base, fileError: parsed.fileError, summary: emptySummary(0), issues: [] };

  if (input.allowedStatuses.length === 0)
    return {
      ...base,
      fileError: "The project has no configured statuses to import into",
      summary: emptySummary(parsed.rows.length),
      issues: [],
    };

  const statusByKey = new Map(
    input.allowedStatuses.map((name) => [name.trim().toLowerCase(), name]),
  );
  const defaultStatus = input.allowedStatuses[0] as string;
  const existing = new Set(input.existingTitleKeys.map(titleKey));

  const issues: ImportRowIssue[] = parsed.rowErrors.map((error) => ({
    rowNumber: error.rowNumber,
    field: error.field,
    kind: "INVALID",
    message: error.message,
  }));

  const rows: ImportPreviewRow[] = [];
  const seenInFile = new Map<string, number>();
  let duplicateInFile = 0;
  let duplicateExisting = 0;

  for (const source of parsed.rows) {
    const coerced = coerceImportValues(source.values);
    if (coerced.errors.length > 0) {
      for (const error of coerced.errors)
        issues.push({
          rowNumber: source.rowNumber,
          field: error.field,
          kind: "INVALID",
          message: error.message,
        });
      continue;
    }

    const parsedRow = ticketImportRowSchema.safeParse(coerced.values);
    if (!parsedRow.success) {
      for (const issue of parsedRow.error.issues)
        issues.push({
          rowNumber: source.rowNumber,
          field: issueField(issue),
          kind: "INVALID",
          message: issueMessage(issue),
        });
      continue;
    }

    const requested = parsedRow.data.status;
    const resolvedStatus = requested
      ? statusByKey.get(requested.toLowerCase())
      : defaultStatus;
    if (!resolvedStatus) {
      issues.push({
        rowNumber: source.rowNumber,
        field: "status",
        kind: "INVALID",
        message: `"${requested ?? ""}" is not a status configured on this project`,
      });
      continue;
    }

    const key = titleKey(parsedRow.data.title);
    const firstSeenAt = seenInFile.get(key);
    if (firstSeenAt !== undefined) {
      duplicateInFile += 1;
      issues.push({
        rowNumber: source.rowNumber,
        field: "title",
        kind: "DUPLICATE_IN_FILE",
        message: `Repeats the title on row ${firstSeenAt}`,
      });
      continue;
    }
    seenInFile.set(key, source.rowNumber);

    if (existing.has(key)) {
      duplicateExisting += 1;
      issues.push({
        rowNumber: source.rowNumber,
        field: "title",
        kind: "DUPLICATE_EXISTING",
        message: "A ticket with this title already exists in the project",
      });
      continue;
    }

    rows.push({
      rowNumber: source.rowNumber,
      values: { ...parsedRow.data, status: resolvedStatus },
    });
  }

  const invalid = issues.filter((issue) => issue.kind === "INVALID").length;

  return {
    format: parsed.format,
    projectId,
    fileError: null,
    summary: {
      totalRows: parsed.rows.length + parsed.rowErrors.length,
      importable: rows.length,
      invalid,
      duplicateInFile,
      duplicateExisting,
    },
    rows,
    issues: issues.sort((a, b) => a.rowNumber - b.rowNumber),
    confirmationToken: rows.length > 0 ? confirmationTokenFor(orgId, projectId, rows) : null,
  };
}
