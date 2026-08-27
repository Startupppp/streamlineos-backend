import { defineCapability, type McpCapability } from "../mcp-capability";
import {
  mcpAttributionArgumentsSchema,
  mcpListDealsArgumentsSchema,
  mcpLogActivityArgumentsSchema,
  mcpReadDealArgumentsSchema,
  mcpTimelineArgumentsSchema,
} from "../dto/crm-mcp.schemas";

/**
 * Everything a customer's own tooling can do to their CRM through the protocol.
 *
 * Phase 6, ticket 19. Every entry here is a thin call into a service that
 * already exists and that a controller already calls — the protocol is a second
 * doorway onto the same rooms, never a second set of rooms. Read it as the
 * ticket's fourth criterion in list form: if a capability wanted something no
 * service does, it would not appear here until the service did.
 *
 * Two things are deliberately absent, and their absence is the fifth criterion.
 *
 * There is no capability that grants, revokes, scopes or escalates a permission
 * — nothing under `access:`, `rbac:`, `ownership:`, `settings:` or `billing:` —
 * so an agent acting through this surface has no move available that changes
 * what it is allowed to do next. `ai-is-barred-from-authorization.spec.ts`
 * asserts that over the catalogue rather than trusting this paragraph.
 *
 * And there is no model anywhere near this file. The decision about whether a
 * call is permitted is taken by `authorize()` from facts in the database, before
 * `invoke` is reached; nothing an agent writes in `arguments` is an input to it.
 * An agent can be as persuasive as it likes in a `subject` field and the answer
 * does not move.
 */

/**
 * The timeline, which is the read this surface exists for.
 *
 * `crm:activities:view` rather than a key of its own: a person with that
 * permission reads this timeline on the CRM's own screen, and the agent reads
 * exactly what they read.
 */
const readTimeline = defineCapability({
  name: "crm.timeline.read",
  description:
    "Read the unified activity timeline for one party, deal or subject, newest first.",
  permission: "crm:activities:view",
  mutates: false,
  auditAction: "crm.mcp.timeline.read",
  arguments: {
    partyId: "The customer to read the timeline of. One anchor is required.",
    dealId: "The deal to read the timeline of.",
    subjectId: "The subject to read the timeline of.",
    kind: "Optional: call, email, meeting, note or task.",
    cursor: "Opaque page cursor from a previous call.",
    limit: "How many entries, 1 to 100. Defaults to 25.",
  },
  schema: mcpTimelineArgumentsSchema,
  run: (services, caller, input) => services.activities.timeline(caller.orgId, input),
});

/**
 * Recording something that happened, which is the one write in the catalogue.
 *
 * The activity is written as a SYSTEM actor labelled with the token, not as the
 * token's owner. A machine that logged a call did not have the call, and
 * `activities.actor_kind` exists exactly so a reader can tell — attributing it
 * to the owner would put a fiction on the customer's timeline, where it would
 * outlive everyone who knew the difference.
 */
const logActivity = defineCapability({
  name: "crm.activity.log",
  description:
    "Record a call, email, meeting, note or task on a party, deal or subject's timeline.",
  permission: "crm:activities:manage",
  mutates: true,
  auditAction: "crm.mcp.activity.log",
  arguments: {
    kind: "call, email, meeting, note or task.",
    partyId: "The customer this belongs to. One anchor is required.",
    dealId: "The deal this belongs to.",
    subjectId: "The subject this belongs to.",
    occurredAt: "When it happened, ISO 8601. Defaults to now.",
    subject: "A one-line summary.",
    body: "The detail.",
    threadId: "The conversation this belongs to, if there is one.",
  },
  schema: mcpLogActivityArgumentsSchema,
  run: (services, caller, input) =>
    services.activities.create(
      caller.orgId,
      { kind: "system", label: caller.actorLabel },
      { ...input, participants: [] },
      "mcp",
    ),
});

const readDeal = defineCapability({
  name: "crm.deal.read",
  description: "Read one deal by id.",
  permission: "crm:deals:read",
  mutates: false,
  auditAction: "crm.mcp.deal.read",
  arguments: { dealId: "The numeric id of the deal." },
  schema: mcpReadDealArgumentsSchema,
  run: (services, caller, input) => services.deals.getDeal(caller.orgId, input.dealId),
});

/**
 * Listing deals, narrowed by the scope the access service decided.
 *
 * `caller.scope` is passed straight through to the same service argument a
 * controller fills from `req.rbacScope`. An agent whose owner sees only their
 * own deals sees only their own deals here, and the narrowing is not this
 * file's judgement — it is the answer `authorize()` already gave.
 */
const listDeals = defineCapability({
  name: "crm.deal.list",
  description: "List deals, optionally filtered by stage or assignee.",
  permission: "crm:deals:read",
  mutates: false,
  auditAction: "crm.mcp.deal.list",
  arguments: {
    stage: "Optional stage key to filter by.",
    assignedToId: "Optional user id to filter by.",
    limit: "How many deals, 1 to 100. Defaults to 25.",
    offset: "How many to skip. Defaults to 0.",
  },
  schema: mcpListDealsArgumentsSchema,
  run: (services, caller, input) =>
    services.deals.listDeals(caller.orgId, caller.userId, input, caller.scope),
});

/**
 * Multi-touch attribution, through ticket 18's service rather than a query.
 *
 * The model is a required argument for the same reason the HTTP surface has no
 * default: a figure has to say which model produced it, and a default is a
 * model nobody chose being quoted as though somebody had.
 */
const attributionReport = defineCapability({
  name: "crm.attribution.report",
  description:
    "Attribute closed-won revenue in a window across the touches that produced it, under a named model.",
  permission: "crm:reports:view",
  mutates: false,
  auditAction: "crm.mcp.attribution.report",
  arguments: {
    model: "first-touch, last-touch, linear, time-decay or position-based.",
    from: "Start of the window, ISO 8601.",
    to: "End of the window, ISO 8601.",
  },
  schema: mcpAttributionArgumentsSchema,
  run: (services, caller, input) =>
    services.attribution.report(caller.orgId, {
      model: input.model,
      from: new Date(input.from),
      to: new Date(input.to),
    }),
});

export const CRM_CAPABILITIES: readonly McpCapability[] = [
  readTimeline,
  logActivity,
  readDeal,
  listDeals,
  attributionReport,
] as const;

export const CAPABILITIES_BY_NAME: ReadonlyMap<string, McpCapability> = new Map(
  CRM_CAPABILITIES.map((capability) => [capability.name, capability]),
);
