import { z } from "zod";
import {
  canConnectorLand,
  ConnectorShapeError,
  describePayload,
  readCell,
  readModifiedAt,
  type ConnectorDescriptor,
  type ConnectorField,
  type ConnectorRequest,
  type ConnectorStream,
  type ConnectorStreamDescriptor,
  type SourcePage,
  type SourceRecord,
} from "./connector-source";

/**
 * Pipedrive, through the v1 collection endpoints.
 *
 * The only one of the four that pages by offset rather than by cursor, and the
 * offset is still the provider's: `additional_data.pagination.next_start` is a
 * number Pipedrive computed, and the walk uses that number rather than adding
 * the page size to where it thinks it is. The distinction matters after a
 * partial page — the arithmetic answer and Pipedrive's answer differ, and the
 * one that skips records is ours.
 *
 * Every Pipedrive export header is `Entity - Field`, which is why the headers
 * below look redundant: `Organization - Name` really is what its CSV writes, and
 * matching it exactly is what makes the API path and the paste path produce the
 * same intermediate. It is also load-bearing for correctness — `Person -
 * Organization` names a *different record*, and the mapping guard reads that
 * prefix to keep it out of the name column.
 */

const PAGE_SIZE = 100;

const recordSchema = z.record(z.string(), z.unknown());

const pageSchema = z.object({
  /**
   * Required, and it is the envelope check.
   *
   * Pipedrive answers an empty collection with `data: null` rather than `[]`, so
   * `data` alone cannot tell a real empty page from an error body — with `data`
   * merely optional, `{}` and `{ "error": "unauthorized" }` would both parse as
   * a drained collection and advance the watermark over records never read.
   * `success` is on every Pipedrive response and on no error body that is not
   * one, so requiring it is what makes the absence of `data` meaningful.
   */
  success: z.boolean(),
  data: z.array(recordSchema).nullish(),
  additional_data: z
    .object({
      pagination: z
        .object({
          more_items_in_collection: z.boolean().nullish(),
          next_start: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const ORGANIZATION_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Organization - ID" },
  { apiField: "name", header: "Organization - Name" },
  { apiField: "address", header: "Organization - Address" },
  { apiField: "owner_id.name", header: "Organization - Owner" },
  { apiField: "label", header: "Organization - Label" },
  { apiField: "people_count", header: "Organization - People count" },
  { apiField: "open_deals_count", header: "Organization - Open deals" },
  { apiField: "add_time", header: "Organization - Created" },
  { apiField: "update_time", header: "Organization - Update time" },
];

const PERSON_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Person - ID" },
  { apiField: "name", header: "Person - Name" },
  { apiField: "primary_email", header: "Person - Email" },
  { apiField: "phone.0.value", header: "Person - Phone" },
  { apiField: "org_id.name", header: "Person - Organization" },
  { apiField: "owner_id.name", header: "Person - Owner" },
  { apiField: "label", header: "Person - Label" },
  { apiField: "update_time", header: "Person - Update time" },
];

const DEAL_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Deal - ID" },
  { apiField: "title", header: "Deal - Title" },
  { apiField: "value", header: "Deal - Value" },
  { apiField: "stage_id", header: "Deal - Stage" },
  { apiField: "pipeline_id", header: "Deal - Pipeline" },
  { apiField: "owner_id.name", header: "Deal - Owner" },
  { apiField: "org_id.name", header: "Deal - Organization" },
  { apiField: "person_id.name", header: "Deal - Contact person" },
  { apiField: "expected_close_date", header: "Deal - Expected close date" },
  { apiField: "update_time", header: "Deal - Update time" },
];

const ACTIVITY_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Activity - ID" },
  { apiField: "subject", header: "Activity - Subject" },
  { apiField: "type", header: "Activity - Type" },
  { apiField: "due_date", header: "Activity - Due date" },
  { apiField: "note", header: "Activity - Note" },
  { apiField: "owner_name", header: "Activity - Assigned to user" },
  { apiField: "org_name", header: "Activity - Organization" },
  { apiField: "update_time", header: "Activity - Update time" },
];

function collectionPath(collection: string, start: number): string {
  return `/v1/${collection}?limit=${String(PAGE_SIZE)}&start=${String(start)}`;
}

function parse(
  stream: ConnectorStream,
  collection: string,
  fields: readonly ConnectorField[],
  modifiedField: string,
  raw: unknown,
): SourcePage {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorShapeError("pipedrive", stream, describePayload(raw));

  const records: SourceRecord[] = (parsed.data.data ?? []).map((record) => ({
    sourceId: readCell(record, "id"),
    modifiedAt: readModifiedAt(record, modifiedField),
    values: Object.fromEntries(
      fields.map((field) => [field.header, readCell(record, field.apiField)]),
    ),
  }));

  /**
   * Pipedrive's own next offset, and only that.
   *
   * `more_items_in_collection` without a `next_start` is a page we cannot
   * continue from without computing the offset ourselves, and a computed offset
   * after a short page skips whatever the difference was. Drained is the reading
   * that cannot lose records.
   */
  const pagination = parsed.data.additional_data?.pagination;
  const nextStart = pagination?.next_start;
  const next: ConnectorRequest | null =
    pagination?.more_items_in_collection === true && typeof nextStart === "number"
      ? { method: "GET", path: collectionPath(collection, nextStart) }
      : null;

  return { records, next };
}

function stream(
  name: ConnectorStream,
  collection: string,
  fields: readonly ConnectorField[],
  modifiedField: string,
  target: ConnectorStreamDescriptor["target"],
): ConnectorStreamDescriptor {
  return {
    target,
    writable: canConnectorLand(target),
    fields,
    // `since` is deliberately unused: the v1 collection endpoints have no
    // modified-time filter, and `/v1/recents` is a differently-shaped payload
    // this parser would have to guess at.
    firstRequest: () => ({ method: "GET", path: collectionPath(collection, 0) }),
    parsePage: (raw) => parse(name, collection, fields, modifiedField, raw),
  };
}

export const PIPEDRIVE_CONNECTOR: ConnectorDescriptor = {
  provider: "pipedrive",
  toolkit: "pipedrive",
  streams: {
    accounts: stream("accounts", "organizations", ORGANIZATION_FIELDS, "update_time", "party"),
    contacts: stream("contacts", "persons", PERSON_FIELDS, "update_time", "subject"),
    deals: stream("deals", "deals", DEAL_FIELDS, "update_time", "pipeline"),
    activities: stream("activities", "activities", ACTIVITY_FIELDS, "update_time", "activity"),
  },
};
