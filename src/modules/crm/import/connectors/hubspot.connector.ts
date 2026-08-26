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
 * HubSpot, through the CRM objects list endpoint.
 *
 * Two things about this one are worth stating rather than discovering.
 *
 * **The cursor is assembled, not followed.** HubSpot returns both
 * `paging.next.after` (an opaque cursor) and `paging.next.link` (a full URL).
 * The link is the thing you would rather follow, and it cannot be used:
 * `ComposioGateway.executeProxy` takes a *path* and lets Composio resolve the
 * base from the connected account, so handing it an absolute URL is not a
 * request this repository can make. So `after` is appended to the same path the
 * walk started from. That is one documented parameter name assembled by us, and
 * it is the only one in any of the four connectors.
 *
 * **There is no `since` filter here.** The list endpoint has none, and the
 * search endpoint that does is a POST whose body shape — `filterGroups`,
 * `propertyName`, `operator: "GTE"` — is four argument names this repository has
 * no call site to check against. A mistyped filter is not rejected, it silently
 * changes which records come back, and that is the failure mode the whole
 * connector design is trying to avoid. So the walk reads forward and the floor
 * is not expressed at all; correctness does not depend on it, because the
 * watermark only advances when a walk drains.
 */

const OBJECT_PATH = "/crm/v3/objects";
const PAGE_SIZE = 100;

const objectSchema = z.object({
  id: z.union([z.string(), z.number()]),
  properties: z.record(z.string(), z.unknown()).nullish(),
  updatedAt: z.string().nullish(),
});

const listSchema = z.object({
  results: z.array(objectSchema),
  paging: z
    .object({ next: z.object({ after: z.string().nullish() }).nullish() })
    .nullish(),
});

/** HubSpot's property names, against the headers its Companies export writes. */
const COMPANY_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record ID" },
  { apiField: "properties.name", header: "Company name" },
  { apiField: "properties.domain", header: "Company Domain Name" },
  { apiField: "properties.phone", header: "Phone Number" },
  { apiField: "properties.industry", header: "Industry" },
  { apiField: "properties.numberofemployees", header: "Number of Employees" },
  { apiField: "properties.annualrevenue", header: "Annual Revenue" },
  { apiField: "properties.city", header: "City" },
  { apiField: "properties.zip", header: "Postal Code" },
  { apiField: "properties.country", header: "Country/Region" },
  { apiField: "properties.description", header: "Description" },
  { apiField: "properties.linkedin_company_page", header: "Linkedin Company Page" },
  /**
   * The API answers this with an owner ID where the CSV export writes the
   * owner's name — resolving it would be a second request per distinct owner,
   * against an endpoint this repository cannot verify. Either way the column is
   * a cross-reference and lands as a custom field, so the fidelity gap costs a
   * less readable value and never an identity.
   */
  { apiField: "properties.hubspot_owner_id", header: "Company owner" },
  { apiField: "properties.createdate", header: "Create Date" },
];

const CONTACT_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record ID" },
  { apiField: "properties.firstname", header: "First Name" },
  { apiField: "properties.email", header: "Email" },
  { apiField: "properties.phone", header: "Phone Number" },
  { apiField: "properties.mobilephone", header: "Mobile Phone Number" },
  { apiField: "properties.jobtitle", header: "Job Title" },
  { apiField: "properties.lifecyclestage", header: "Lifecycle Stage" },
  { apiField: "properties.hs_lead_status", header: "Lead Status" },
  { apiField: "properties.address", header: "Street Address" },
  { apiField: "properties.createdate", header: "Create Date" },
];

const DEAL_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record ID" },
  { apiField: "properties.dealname", header: "Deal Name" },
  { apiField: "properties.dealstage", header: "Deal Stage" },
  { apiField: "properties.pipeline", header: "Pipeline" },
  { apiField: "properties.amount", header: "Amount" },
  { apiField: "properties.dealtype", header: "Deal Type" },
  { apiField: "properties.closedate", header: "Close Date" },
  { apiField: "properties.createdate", header: "Create Date" },
];

const ENGAGEMENT_FIELDS: readonly ConnectorField[] = [
  { apiField: "id", header: "Record ID" },
  { apiField: "properties.hs_task_subject", header: "Subject" },
  { apiField: "properties.hs_task_status", header: "Status" },
  { apiField: "properties.hs_task_priority", header: "Priority" },
  { apiField: "properties.hs_task_body", header: "Notes" },
  { apiField: "properties.hs_timestamp", header: "Activity Date" },
];

/**
 * The list path for one object type.
 *
 * `properties` is explicit because HubSpot returns only a handful of properties
 * by default and silently omits the rest — asking for exactly the declared
 * fields is what stops the header row promising columns the request never
 * fetched.
 */
function listPath(object: string, fields: readonly ConnectorField[]): string {
  const properties = fields
    .map((field) => field.apiField)
    .filter((apiField) => apiField.startsWith("properties."))
    .map((apiField) => apiField.slice("properties.".length))
    .join(",");

  return `${OBJECT_PATH}/${object}?limit=${String(PAGE_SIZE)}&properties=${encodeURIComponent(properties)}`;
}

function parse(
  stream: ConnectorStream,
  object: string,
  fields: readonly ConnectorField[],
  raw: unknown,
): SourcePage {
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorShapeError("hubspot", stream, describePayload(raw));

  const records: SourceRecord[] = parsed.data.results.map((record) => ({
    sourceId: String(record.id),
    /**
     * The envelope's `updatedAt`, not the `hs_lastmodifieddate` property.
     *
     * The property is only present if it was asked for, and a property nobody
     * requested reads as absent rather than as an error — so a watermark built
     * on it would silently stop advancing the day the property list changed.
     */
    modifiedAt: readModifiedAt(record, "updatedAt"),
    values: Object.fromEntries(
      fields.map((field) => [field.header, readCell(record, field.apiField)]),
    ),
  }));

  const after = parsed.data.paging?.next?.after;
  const next: ConnectorRequest | null = after
    ? { method: "GET", path: `${listPath(object, fields)}&after=${encodeURIComponent(after)}` }
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
    writable: target === "party",
    fields,
    // `since` is deliberately unused — see the file docblock.
    firstRequest: () => ({ method: "GET", path: listPath(object, fields) }),
    parsePage: (raw) => parse(name, object, fields, raw),
  };
}

export const HUBSPOT_CONNECTOR: ConnectorDescriptor = {
  provider: "hubspot",
  toolkit: "hubspot",
  streams: {
    accounts: stream("accounts", "companies", COMPANY_FIELDS, "party"),
    contacts: stream("contacts", "contacts", CONTACT_FIELDS, "subject"),
    deals: stream("deals", "deals", DEAL_FIELDS, "pipeline-stage"),
    activities: stream("activities", "tasks", ENGAGEMENT_FIELDS, "activity"),
  },
};
