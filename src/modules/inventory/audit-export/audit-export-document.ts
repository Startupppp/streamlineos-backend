import { createHash } from "node:crypto";

/**
 * The canonical byte format of an inventory audit export.
 *
 * Nothing here touches a database. The checksum is worth exactly what its
 * inputs are, so the encoding is defined once, in one place, over values that
 * are already strings by the time they arrive: every column is rendered to
 * `text` by Postgres itself, so an 18,4 numeric reaches this file as `'5.0000'`
 * and is written verbatim. No value is ever parsed into a JavaScript number.
 *
 * A document is a sequence of LF-terminated lines, UTF-8, no BOM, with a
 * trailing newline after the final line:
 *
 *   1. one manifest object
 *   2. per section: one section-header object naming its columns in order,
 *      then one JSON array per row holding that section's values in exactly
 *      that order
 *
 * Rows are arrays rather than objects on purpose: an array has an order, and a
 * hash over an object whose key order is not pinned verifies nothing. The two
 * object lines are built through `jsonObject`, which takes ordered pairs, so
 * their key order is a property of the call rather than of object-literal
 * iteration.
 *
 * The manifest deliberately carries nothing that varies between two exports of
 * the same evidence version — no timestamp, no job id, no actor. Those live on
 * the job row and in HTTP headers. Putting any of them in the document would
 * make "same evidence version, identical bytes" false by construction.
 */
export const AUDIT_EXPORT_FORMAT = "streamlineos.inventory.audit-export";
export const AUDIT_EXPORT_SCHEMA_VERSION = 1;

export const AUDIT_EXPORT_SECTIONS = ["ledger", "audit_events"] as const;
export type AuditExportSection = (typeof AUDIT_EXPORT_SECTIONS)[number];

/**
 * Exactly the columns migration 0529's `BEFORE UPDATE` trigger refuses to let
 * change. `notes`, `reason` and `metadata` are absent because the trigger
 * leaves them editable: an annotation is a description of a movement rather
 * than the movement, so including it would put mutable free text — the same
 * free text an operator can paste a credential into — inside a document that
 * claims to be reproducible.
 */
export const LEDGER_COLUMNS = [
  "id",
  "org_id",
  "product_variant_id",
  "location_id",
  "transaction_type",
  "quantity_bucket",
  "quantity_change",
  "quantity_before",
  "quantity_after",
  "lot_id",
  "serial_id",
  "unit_cost",
  "total_cost",
  "posting_date",
  "idempotency_key",
  "reference_type",
  "reference_id",
  "correction_of_transaction_id",
  "created_by",
  "created_at",
] as const;

/**
 * `before`, `after` and `metadata` are entity snapshots: vendor bank details,
 * costs, webhook secrets, anything a service happened to pass. They are
 * redacted to a SHA-256 of their `jsonb::text` rendering, which is stable
 * because jsonb normalises key order at storage time. An auditor holding the
 * source row can still prove the payload is the one that was exported; the
 * export itself carries none of it.
 */
export const AUDIT_EVENT_COLUMNS = [
  "id",
  "org_id",
  "actor_user_id",
  "action",
  "resource_type",
  "resource_id",
  "before_sha256",
  "after_sha256",
  "metadata_sha256",
  "created_at",
] as const;

export const SECTION_COLUMNS: Readonly<Record<AuditExportSection, readonly string[]>> = {
  ledger: LEDGER_COLUMNS,
  audit_events: AUDIT_EVENT_COLUMNS,
};

export interface AuditExportManifest {
  orgId: string;
  /** `L<ledgerCeiling>` / `A<auditCeiling>` for the sections present, joined by `.`. */
  evidenceVersion: string;
  /** Ascending warehouse ids as text, or `null` for the org-wide scope. */
  warehouseIds: readonly string[] | null;
  from: string | null;
  to: string | null;
  sections: readonly AuditExportSection[];
  rowCounts: Readonly<Record<AuditExportSection, number>>;
}

function jsonObject(entries: readonly (readonly [string, string])[]): string {
  return `{${entries.map(([key, raw]) => `${JSON.stringify(key)}:${raw}`).join(",")}}`;
}

function jsonStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function jsonNullableString(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

export function encodeManifestLine(manifest: AuditExportManifest): string {
  return jsonObject([
    ["format", JSON.stringify(AUDIT_EXPORT_FORMAT)],
    ["schemaVersion", String(AUDIT_EXPORT_SCHEMA_VERSION)],
    ["orgId", JSON.stringify(manifest.orgId)],
    ["evidenceVersion", JSON.stringify(manifest.evidenceVersion)],
    [
      "scope",
      jsonObject([
        [
          "warehouseIds",
          manifest.warehouseIds === null ? "null" : jsonStringArray(manifest.warehouseIds),
        ],
      ]),
    ],
    [
      "filters",
      jsonObject([
        ["from", jsonNullableString(manifest.from)],
        ["to", jsonNullableString(manifest.to)],
      ]),
    ],
    ["sections", jsonStringArray(manifest.sections)],
    [
      "rowCounts",
      jsonObject(manifest.sections.map((section) => [section, String(manifest.rowCounts[section])])),
    ],
  ]);
}

export function encodeSectionHeaderLine(section: AuditExportSection): string {
  return jsonObject([
    ["section", JSON.stringify(section)],
    ["columns", jsonStringArray(SECTION_COLUMNS[section])],
  ]);
}

export function encodeRowLine(values: readonly (string | null)[]): string {
  return `[${values.map((value) => jsonNullableString(value)).join(",")}]`;
}

/** A line sink that hashes every byte it forwards, so nothing is buffered whole. */
export class AuditExportStream {
  private readonly hash = createHash("sha256");
  private bytes = 0;

  constructor(private readonly sink?: (chunk: Buffer) => Promise<void> | void) {}

  async line(text: string): Promise<void> {
    const chunk = Buffer.from(`${text}\n`, "utf8");
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
    if (this.sink) await this.sink(chunk);
  }

  get byteLength(): number {
    return this.bytes;
  }

  checksum(): string {
    return this.hash.digest("hex");
  }
}

export interface AuditExportVerification {
  ok: boolean;
  expectedChecksum: string;
  actualChecksum: string;
}

/**
 * The offline half of the contract: a verifier that has only the downloaded
 * file and the checksum reported alongside it needs nothing more than this.
 */
export function verifyAuditExportDocument(
  document: string | Buffer,
  expectedChecksum: string,
): AuditExportVerification {
  const bytes = typeof document === "string" ? Buffer.from(document, "utf8") : document;
  const actualChecksum = createHash("sha256").update(bytes).digest("hex");
  return { ok: actualChecksum === expectedChecksum, expectedChecksum, actualChecksum };
}
