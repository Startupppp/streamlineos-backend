/**
 * What a direct connector produces, and why it is not allowed to produce
 * anything else.
 *
 * A connector reads a competitor's API and stops. It does not write a party, it
 * does not decide whether a row is a duplicate, and it does not know what a
 * `business_parties` row looks like. What it produces is a header row and cell
 * rows — **exactly what a person pasting a CSV produces** — which then goes
 * through the same `mapColumns`, the same `planImport`, the same preview, the
 * same durable commit and the same thirty-day undo.
 *
 * That is the ticket's "one destination", and it is structural rather than a
 * convention: there is no other function here that could write anything.
 *
 * ── The header labels are the CSV export's labels, deliberately ────────────
 *
 * The obvious thing is to key a connector's records by the provider's API field
 * name — `hs_lastmodifieddate`, `Account.Name`, `org_id`. Every connector would
 * then need its own mapping onto our fields, four mappings would drift apart,
 * and the mapping evals would measure none of them because the evals are built
 * from export headers.
 *
 * So each connector declares, per field, **the header that product's own CSV
 * export writes** — `Company Domain Name` for HubSpot's `domain`,
 * `Organization - Name` for Pipedrive's `name`. A tenant who exports a CSV and
 * pastes it, and a tenant who connects the API, then produce byte-identical
 * intermediates. One inference, one set of gates, one set of bugs. It also means
 * `evals/datasets/column-mapping.dataset.ts` measures the connectors as well as
 * the paste path, and `connector-catalog.spec.ts` pins that the labels a
 * connector emits are labels that dataset actually covers.
 */

/** What a connector's records can be landed as. */
export type TargetEntity = "party" | "subject" | "pipeline-stage" | "activity";

export type ConnectorProvider = "salesforce" | "hubspot" | "zoho" | "pipedrive";

export const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = [
  "salesforce",
  "hubspot",
  "zoho",
  "pipedrive",
];

export function isConnectorProvider(value: string): value is ConnectorProvider {
  return (CONNECTOR_PROVIDERS as readonly string[]).includes(value);
}

/** The four streams every one of these products has, whatever it calls them. */
export type ConnectorStream = "accounts" | "contacts" | "deals" | "activities";

export const CONNECTOR_STREAMS: readonly ConnectorStream[] = [
  "accounts",
  "contacts",
  "deals",
  "activities",
];

export function isConnectorStream(value: string): value is ConnectorStream {
  return (CONNECTOR_STREAMS as readonly string[]).includes(value);
}

/**
 * One field of one stream.
 *
 * `apiField` is read from the payload; `header` is what goes in the header row.
 * A dotted `apiField` reaches into a nested object, which is the only shape
 * traversal any of these four needs — HubSpot nests everything under
 * `properties`, Pipedrive nests the owner under `owner_id`.
 */
export interface ConnectorField {
  readonly apiField: string;
  readonly header: string;
}

/**
 * A request, as `ComposioGateway.executeProxy` takes one.
 *
 * A type alias rather than an interface, and that is load-bearing rather than
 * style. This travels inside `WalkExtent` and `PageOutcome`, which are the
 * outputs of `sync-begin` and `fetch-page-n`, and a step's output has to satisfy
 * `JsonValue`. TypeScript gives an object type ALIAS an implicit index
 * signature and an interface none, so as an interface this would make both
 * memos fail to compile — the same trap `PhaseExtent` and `ImportSummary`
 * already carry a note about.
 */
export type ConnectorRequest = {
  readonly method: "GET";
  /**
   * A path, not a URL. Composio's proxy resolves the base from the connected
   * account — the Outlook provider passes `/me/messages` the same way.
   */
  readonly path: string;
};

/** One record, as the connector read it. */
export interface SourceRecord {
  /**
   * The provider's own identifier for this record.
   *
   * The claim key: staging is `ON CONFLICT DO NOTHING` on it, so a page re-read
   * after a failure stages nothing twice and a walk can be resumed at any point
   * without duplicating a record.
   */
  readonly sourceId: string;
  /**
   * When the provider last changed it, where the provider says so.
   *
   * The only thing the watermark is ever allowed to move to. `null` is honest
   * rather than convenient: a record whose modification time we could not read
   * contributes nothing to the watermark, so it can never push it past itself.
   */
  readonly modifiedAt: Date | null;
  /** Keyed by the header this product's own CSV export writes. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * One page, as the provider's own pagination defines it.
 *
 * `next` is built from what the provider handed back, never assembled from a
 * guess about how many records we have seen.
 */
export interface SourcePage {
  readonly records: readonly SourceRecord[];
  /** `null` means the provider says there is nothing after this. */
  readonly next: ConnectorRequest | null;
}

export interface ConnectorStreamDescriptor {
  /** What these records would be landed as. */
  readonly target: TargetEntity;
  /**
   * Whether this repository has anywhere to put them today.
   *
   * `false` is not a stub. Only `party` has an importer — a plan, a preview, a
   * durable commit and an undo — and the first thing this ticket asks for is
   * that a connector must not acquire a write path of its own. So a stream whose
   * target has no importer is refused **before any provider call is made**,
   * naming the target, rather than read and quietly dropped. Reading records
   * nobody can land is the failure mode that looks most like success.
   */
  readonly writable: boolean;
  readonly fields: readonly ConnectorField[];
  /** The first request of a walk. `since` is a floor, applied where it can be. */
  firstRequest(since: Date | null): ConnectorRequest;
  /** A raw body as a page, or a throw. Never an empty page as a way of coping. */
  parsePage(raw: unknown): SourcePage;
}

export interface ConnectorDescriptor {
  readonly provider: ConnectorProvider;
  /** What `user_integration_connections.toolkit` would carry. See the catalog. */
  readonly toolkit: string;
  readonly streams: Readonly<Record<ConnectorStream, ConnectorStreamDescriptor>>;
}

/**
 * Refused rather than defaulted, exactly as the telephony adapter refuses.
 *
 * A permissive parse that yields an empty page is the failure this whole area
 * has already lived through once: a sweep that reports itself healthy, delivers
 * nothing, and leaves somebody believing their CRM is being migrated. An
 * unrecognised payload means the request was wrong, the account was wrong, or
 * the provider changed, and all three have to stop the walk with the cursor and
 * the watermark exactly where they were.
 */
export class ConnectorShapeError extends Error {
  constructor(provider: ConnectorProvider, stream: ConnectorStream, received: string) {
    super(
      `The ${provider} ${stream} response was not a page of records. Nothing was read, ` +
        `and nothing has been marked as read. Received: ${received}`,
    );
    this.name = "ConnectorShapeError";
  }
}

/** Enough of an unexpected payload to debug it, and not enough to leak it. */
export function describePayload(raw: unknown): string {
  if (raw === null) return "null";
  if (typeof raw !== "object") return typeof raw;
  if (Array.isArray(raw)) return `array(${String(raw.length)})`;
  return `object{${Object.keys(raw).slice(0, 8).join(",")}}`;
}

/**
 * Reads one field out of a payload, following dots, and flattens it to a cell.
 *
 * A cell is a string because a spreadsheet cell is a string, and the whole point
 * is that this path and the paste path are indistinguishable downstream. An
 * object or an array reaching a cell would be `[object Object]` in somebody's
 * custom field, so it becomes empty instead — the column is still in the header
 * row, so the preview shows it as present and blank rather than losing it.
 */
export function readCell(record: unknown, apiField: string): string {
  let cursor: unknown = record;
  for (const part of apiField.split(".")) {
    if (cursor === null || typeof cursor !== "object") return "";
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
  return "";
}

/** A provider timestamp, or `null` if it is not one we can trust. */
export function readModifiedAt(record: unknown, apiField: string): Date | null {
  const raw = readCell(record, apiField);
  if (!raw) return null;

  // Some of these products write epoch milliseconds and some write ISO 8601.
  const at = new Date(/^\d+$/.test(raw) ? Number(raw) : raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The intermediate: a header row and cell rows, in the connector's field order.
 *
 * Order comes from the descriptor rather than from the keys a record happened to
 * carry, because a provider omits a field it has no value for and two records
 * would otherwise produce two different header rows. Every declared column is
 * present for every record, blank where the provider said nothing — which is
 * also what a CSV export does.
 */
export function toIntermediate(
  fields: readonly ConnectorField[],
  records: readonly SourceRecord[],
): { headers: string[]; rows: string[][] } {
  const headers = fields.map((field) => field.header);
  const rows = records.map((record) => headers.map((header) => record.values[header] ?? ""));
  return { headers, rows };
}

/**
 * The newest modification time in a set of records, or `null`.
 *
 * The watermark's only input. Computed over what was actually staged rather than
 * over what a page contained, so a record that failed to stage cannot advance
 * the line past itself.
 */
export function newestModifiedAt(records: readonly SourceRecord[]): Date | null {
  let newest: Date | null = null;
  for (const record of records) {
    if (!record.modifiedAt) continue;
    if (!newest || record.modifiedAt > newest) newest = record.modifiedAt;
  }
  return newest;
}
