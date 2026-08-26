import { z } from "zod";
import {
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
 * Zoho CRM, through the v6 records API.
 *
 * Zoho's incremental read is an `If-Modified-Since` **header**, not a query
 * parameter. `ComposioGateway.executeProxy` takes `(connectedAccountId, method,
 * endpoint, body)` and has no way to send a header — the Composio SDK's
 * `ToolProxyParams` does have a `parameters` array that carries headers, and our
 * wrapper does not forward it. Widening that wrapper is a change to
 * `integrations/core`, which this ticket does not own.
 *
 * So the floor is not expressed and the walk reads forward. That costs a
 * re-read; it cannot cost a gap, because the watermark only advances when a walk
 * drains. Stated here rather than worked around, because the workaround would
 * have been to guess a query-parameter name — and a query parameter a provider
 * does not recognise is *ignored*, which returns a full unfiltered page that
 * looks exactly like a correct one.
 */

const PER_PAGE = 200;

const recordSchema = z.record(z.string(), z.unknown());

/**
 * `data` may be absent, but the envelope may not.
 *
 * Zoho answers an empty result set with `204 No Content`, so a genuinely empty
 * page can arrive without a `data` array — and the obvious way to allow that is
 * to make `data` nullish and move on. That is wrong, and the first version of
 * this file was wrong in exactly that way: with `data` optional, `{}` and
 * `{ "error": "invalid_grant" }` both parse cleanly as a page of nothing. A
 * revoked token would have read as a drained collection, advanced the watermark
 * over records it never saw, and reported success.
 *
 * So the refinement below requires the payload to look like something Zoho sent:
 * either the records array, or the `info` block that accompanies every page. An
 * object with neither is refused, which is what an error body is.
 */
const pageSchema = z
  .object({
    data: z.array(recordSchema).nullish(),
    info: z
      .object({
        more_records: z.boolean().nullish(),
        next_page_token: z.string().nullish(),
      })
      .nullish(),
  })
  .refine(
    (page) => Array.isArray(page.data) || (page.info !== null && page.info !== undefined),
    "neither a records array nor an info block",
  );

const ACCOUNT_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record Id" },
  { apiField: "Account_Name", header: "Account Name" },
  { apiField: "Account_Type", header: "Account Type" },
  { apiField: "Email", header: "Email" },
  { apiField: "Phone", header: "Phone" },
  { apiField: "Fax", header: "Fax" },
  { apiField: "Website", header: "Website" },
  { apiField: "Description", header: "Description" },
  { apiField: "Billing_Street", header: "Billing Street" },
  { apiField: "Annual_Revenue", header: "Annual Revenue" },
  { apiField: "Employees", header: "Employees" },
  { apiField: "Ownership", header: "Ownership" },
  { apiField: "Parent_Account.name", header: "Parent Account" },
  { apiField: "Owner.name", header: "Account Owner" },
  { apiField: "Modified_Time", header: "Modified Time" },
  { apiField: "Created_Time", header: "Created Time" },
];

const CONTACT_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record Id" },
  { apiField: "Full_Name", header: "Contact Name" },
  { apiField: "Email", header: "Email" },
  { apiField: "Secondary_Email", header: "Secondary Email" },
  { apiField: "Phone", header: "Phone" },
  { apiField: "Mobile", header: "Mobile" },
  { apiField: "Department", header: "Department" },
  { apiField: "Account_Name.name", header: "Account Name" },
  { apiField: "Owner.name", header: "Contact Owner" },
  { apiField: "Modified_Time", header: "Modified Time" },
];

const DEAL_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record Id" },
  { apiField: "Deal_Name", header: "Deal Name" },
  { apiField: "Stage", header: "Stage" },
  { apiField: "Amount", header: "Amount" },
  { apiField: "Closing_Date", header: "Closing Date" },
  { apiField: "Expected_Revenue", header: "Expected Revenue" },
  { apiField: "Account_Name.name", header: "Account Name" },
  { apiField: "Owner.name", header: "Deal Owner" },
  { apiField: "Modified_Time", header: "Modified Time" },
];

const TASK_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record Id" },
  { apiField: "Subject", header: "Subject" },
  { apiField: "Status", header: "Status" },
  { apiField: "Priority", header: "Priority" },
  { apiField: "Due_Date", header: "Due Date" },
  { apiField: "Description", header: "Description" },
  { apiField: "What_Id.name", header: "Related To" },
  { apiField: "Owner.name", header: "Task Owner" },
  { apiField: "Modified_Time", header: "Modified Time" },
];

/**
 * Zoho's records path.
 *
 * `fields` is required by the v6 records API rather than optional, so the
 * explicit list is the provider's rule here rather than our discipline — which
 * happens to be the discipline the other three connectors apply anyway.
 */
function modulePath(module: string, fields: readonly ConnectorField[]): string {
  const columns = fields
    .map((field) => field.apiField.split(".")[0])
    .filter((apiField, index, all) => all.indexOf(apiField) === index)
    .join(",");

  return `/crm/v6/${module}?fields=${encodeURIComponent(columns)}&per_page=${String(PER_PAGE)}`;
}

function parse(
  stream: ConnectorStream,
  module: string,
  fields: readonly ConnectorField[],
  raw: unknown,
): SourcePage {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorShapeError("zoho", stream, describePayload(raw));

  const records: SourceRecord[] = (parsed.data.data ?? []).map((record) => ({
    sourceId: readCell(record, "id"),
    modifiedAt: readModifiedAt(record, "Modified_Time"),
    values: Object.fromEntries(
      fields.map((field) => [field.header, readCell(record, field.apiField)]),
    ),
  }));

  /**
   * The token is what decides, not `more_records`.
   *
   * Zoho sets `more_records: true` alongside a token, and a page claiming more
   * records without one is a page we cannot continue from. Treated as drained
   * for the same reason Salesforce's is: a walk that continues from a request we
   * invented reads page one forever, and a drain that turns out to be early
   * costs a re-read rather than a gap.
   */
  const token = parsed.data.info?.next_page_token;
  const next: ConnectorRequest | null = token
    ? {
        method: "GET",
        path: `${modulePath(module, fields)}&page_token=${encodeURIComponent(token)}`,
      }
    : null;

  return { records, next };
}

function stream(
  name: ConnectorStream,
  module: string,
  fields: readonly ConnectorField[],
  target: ConnectorStreamDescriptor["target"],
): ConnectorStreamDescriptor {
  return {
    target,
    writable: target === "party",
    fields,
    // `since` is deliberately unused — see the file docblock.
    firstRequest: () => ({ method: "GET", path: modulePath(module, fields) }),
    parsePage: (raw) => parse(name, module, fields, raw),
  };
}

export const ZOHO_CONNECTOR: ConnectorDescriptor = {
  provider: "zoho",
  toolkit: "zoho",
  streams: {
    accounts: stream("accounts", "Accounts", ACCOUNT_FIELDS, "party"),
    contacts: stream("contacts", "Contacts", CONTACT_FIELDS, "subject"),
    deals: stream("deals", "Deals", DEAL_FIELDS, "pipeline-stage"),
    activities: stream("activities", "Tasks", TASK_FIELDS, "activity"),
  },
};
