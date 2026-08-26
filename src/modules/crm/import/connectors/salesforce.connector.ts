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
 * Salesforce, through the REST query endpoint.
 *
 * The one of the four whose paging is entirely the provider's: a query returns
 * `nextRecordsUrl`, already a path, and the walk follows it verbatim rather than
 * assembling anything. It is also the only one of the four that can express the
 * watermark floor **in the request** — SOQL has a `WHERE` clause — which is why
 * `since` is used here and ignored in the other three. Correctness does not
 * depend on that either way: see `crm-connector.service.ts` for why the
 * watermark only moves when a walk drains.
 */

const API_VERSION = "v59.0";

const recordSchema = z.record(z.string(), z.unknown());

const querySchema = z.object({
  records: z.array(recordSchema),
  /** Present and false while there are more pages. */
  done: z.boolean().nullish(),
  /** A path, which is what makes this the easiest of the four to page. */
  nextRecordsUrl: z.string().nullish(),
});

/**
 * The columns a Salesforce **Accounts** export writes, against the API fields
 * that fill them.
 *
 * `Parent.Name` and `Owner.Name` rather than `ParentId` and `OwnerId`: an id
 * from another system is not importable and the name is what a person reading
 * the preview can check. Both are cross-references — see the mapping dataset —
 * so both land as custom fields, which is the point of carrying them at all.
 */
const ACCOUNT_FIELDS: readonly ConnectorField[] = [
  { apiField: "Id", header: "Account ID" },
  { apiField: "Name", header: "Account Name" },
  { apiField: "AccountNumber", header: "Account Number" },
  { apiField: "Site", header: "Account Site" },
  { apiField: "Type", header: "Type" },
  { apiField: "Phone", header: "Phone" },
  { apiField: "Fax", header: "Fax" },
  { apiField: "Website", header: "Website" },
  { apiField: "Description", header: "Description" },
  { apiField: "BillingStreet", header: "Billing Street" },
  { apiField: "AnnualRevenue", header: "Annual Revenue" },
  { apiField: "Rating", header: "Rating" },
  { apiField: "Parent.Name", header: "Parent Account" },
  { apiField: "Owner.Name", header: "Account Owner" },
  { apiField: "LastModifiedDate", header: "Last Modified Date" },
];

const CONTACT_FIELDS: readonly ConnectorField[] = [
  { apiField: "Id", header: "Contact ID" },
  { apiField: "Name", header: "Full Name" },
  { apiField: "FirstName", header: "First Name" },
  { apiField: "Salutation", header: "Salutation" },
  { apiField: "Email", header: "Email" },
  { apiField: "Phone", header: "Phone" },
  { apiField: "MobilePhone", header: "Mobile Phone" },
  { apiField: "AssistantPhone", header: "Asst. Phone" },
  { apiField: "AssistantName", header: "Assistant" },
  { apiField: "ReportsTo.Name", header: "Reports To" },
  { apiField: "MailingStreet", header: "Mailing Street" },
  { apiField: "LeadSource", header: "Lead Source" },
  { apiField: "Owner.Name", header: "Contact Owner" },
  { apiField: "LastModifiedDate", header: "Last Modified Date" },
];

const OPPORTUNITY_FIELDS: readonly ConnectorField[] = [
  { apiField: "Id", header: "Opportunity ID" },
  { apiField: "Name", header: "Opportunity Name" },
  { apiField: "StageName", header: "Stage" },
  { apiField: "Amount", header: "Amount" },
  { apiField: "CloseDate", header: "Close Date" },
  { apiField: "NextStep", header: "Next Step" },
  { apiField: "Account.Name", header: "Account Name" },
  { apiField: "Owner.Name", header: "Opportunity Owner" },
  { apiField: "LastModifiedDate", header: "Last Modified Date" },
];

const TASK_FIELDS: readonly ConnectorField[] = [
  { apiField: "Id", header: "Task ID" },
  { apiField: "Subject", header: "Subject" },
  { apiField: "Status", header: "Status" },
  { apiField: "Priority", header: "Priority" },
  { apiField: "ActivityDate", header: "Due Date Only" },
  { apiField: "Description", header: "Comments" },
  { apiField: "What.Name", header: "Related To" },
  { apiField: "Owner.Name", header: "Assigned" },
  { apiField: "LastModifiedDate", header: "Last Modified Date" },
];

/**
 * A SOQL query as a path.
 *
 * The field list is explicit rather than `FIELDS(ALL)`: a query that asks for
 * everything returns columns nobody declared a header for, and those would be
 * dropped silently on the way into the intermediate. Asking for exactly the
 * declared fields means the request and the header row cannot disagree.
 */
function queryPath(object: string, fields: readonly ConnectorField[], since: Date | null): string {
  const columns = fields.map((field) => field.apiField).join(", ");
  const where = since ? ` WHERE LastModifiedDate > ${since.toISOString()}` : "";
  const soql = `SELECT ${columns} FROM ${object}${where}`;
  return `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
}

function parse(
  stream: ConnectorStream,
  fields: readonly ConnectorField[],
  raw: unknown,
): SourcePage {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorShapeError("salesforce", stream, describePayload(raw));

  const records: SourceRecord[] = parsed.data.records.map((record) => ({
    sourceId: readCell(record, "Id"),
    modifiedAt: readModifiedAt(record, "LastModifiedDate"),
    values: Object.fromEntries(
      fields.map((field) => [field.header, readCell(record, field.apiField)]),
    ),
  }));

  /**
   * `done` is trusted over the presence of a URL, and the URL over nothing.
   *
   * A page that says `done: false` and hands back no URL is a payload we cannot
   * walk, and continuing from a request we invented is how a walk silently reads
   * page one forever. Treated as drained, which is the reading that cannot
   * duplicate or loop — and the watermark only moves on a drain, so the cost is
   * a re-read next time rather than a gap.
   */
  const next: ConnectorRequest | null = parsed.data.nextRecordsUrl
    ? { method: "GET", path: parsed.data.nextRecordsUrl }
    : null;

  return { records, next };
}

function stream(
  name: ConnectorStream,
  object: string,
  fields: readonly ConnectorField[],
  target: ConnectorStreamDescriptor["target"],
): ConnectorStreamDescriptor {
  return {
    target,
    writable: canConnectorLand(target),
    fields,
    firstRequest: (since) => ({ method: "GET", path: queryPath(object, fields, since) }),
    parsePage: (raw) => parse(name, fields, raw),
  };
}

export const SALESFORCE_CONNECTOR: ConnectorDescriptor = {
  provider: "salesforce",
  toolkit: "salesforce",
  streams: {
    accounts: stream("accounts", "Account", ACCOUNT_FIELDS, "party"),
    contacts: stream("contacts", "Contact", CONTACT_FIELDS, "subject"),
    deals: stream("deals", "Opportunity", OPPORTUNITY_FIELDS, "pipeline"),
    activities: stream("activities", "Task", TASK_FIELDS, "activity"),
  },
};
