import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { sql, type Column, type SQL } from "drizzle-orm";
import { businessParties, contactPartyMap, leadPartyMap } from "../../../../db/schema/party";
import type { Db } from "../../../../db/drizzle.module";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import type { LimitKey } from "../plan-entitlements.constants";
import { readCount } from "../quota-counts";
import { seatCount } from "../seat-definition";

/**
 * The per-limit-key table: what each metered thing is called, and the SQL that
 * counts it.
 *
 * This is a data table with two accessors over it, and it is a different kind of
 * thing from the policy that reads it. `PlanLimitsService` decides which plan an
 * organisation is on, whether a limit applies and what to do when it is crossed;
 * none of that changes when a fifteenth metered resource is added. What changes
 * is exactly this file: one label, one branch in `fetchCount`, one column in
 * `fetchAllCounts`. Keeping the fourteen-way switch beside the policy meant a
 * hundred and forty lines of counting queries sat between `assertWithinLimit`
 * and the alerting it triggers.
 *
 * The two accessors are deliberately not one. `fetchAllCounts` fetches all
 * fourteen in a SINGLE statement because the entitlements screen needs every
 * number at once and fourteen round trips is the alternative; `fetchCount`
 * answers one key and takes an `executor`, because a seat check must run inside
 * the caller's transaction to be a serialized write invariant. Collapsing them
 * would cost one of those two properties.
 *
 * Free functions over a deps bag, not a second `@Injectable`: the DI graph and
 * every caller are unchanged.
 */
export interface PlanLimitCountDeps {
  readonly db: Db;
  readonly logger: Logger;
}

function liveCustomerCount(partyIdColumn: Column, orgColumn: Column, orgId: string): SQL {
  return sql`SELECT count(distinct ${businessParties.partyId})::int
    FROM ${businessParties}
    JOIN ${partyIdColumn.table} ON ${partyIdColumn} = ${businessParties.partyId}
      AND ${orgColumn} = ${businessParties.organizationId}
    WHERE ${businessParties.organizationId} = ${orgId}
      AND ${businessParties.deletedAt} IS NULL`;
}

/**
 * The human name a quota message uses. Read by the 402 body and by the quota
 * alert, and iterated by `fetchAllCounts` — so this object, not a separate
 * array, is the list of metered keys.
 */
export const LIMIT_KEY_LABELS: Record<LimitKey, string> = {
  members: "team members",
  projects: "projects",
  kbPages: "knowledge base pages",
  chatChannels: "chat channels",
  crmLeads: "CRM leads",
  crmContacts: "CRM contacts",
  crmDeals: "CRM deals",
  supportTickets: "support tickets",
  automations: "automations",
  signEnvelopes: "sign envelopes",
  surveys: "surveys",
  acctInvoices: "accounting invoices",
  hrCandidates: "HR candidates",
  hrJobPostings: "HR job postings",
};

export async function fetchAllCounts(deps: PlanLimitCountDeps, orgId: string): Promise<Record<LimitKey, number>> {
  try {
    const rows = await deps.db.execute(sql`
      SELECT
        ${seatCount(orgId)}                                                                                                              AS members,
        (SELECT COUNT(*)::int FROM build.projects WHERE org_id = ${orgId})                                                              AS projects,
        (SELECT COUNT(*)::int FROM kb_pages WHERE org_id = ${orgId} AND deleted_at IS NULL)                                             AS "kbPages",
        (SELECT COUNT(*)::int FROM chat_channels WHERE org_id = ${orgId})                                                               AS "chatChannels",
        (${liveCustomerCount(leadPartyMap.partyId, leadPartyMap.organizationId, orgId)})                                                AS "crmLeads",
        (${liveCustomerCount(contactPartyMap.partyId, contactPartyMap.organizationId, orgId)})                                          AS "crmContacts",
        (SELECT COUNT(*)::int FROM deals WHERE org_id = ${orgId})                                                                    AS "crmDeals",
        (SELECT COUNT(*)::int FROM support_tickets WHERE org_id = ${orgId})                                                             AS "supportTickets",
        (SELECT COUNT(*)::int FROM automation_rules WHERE org_id = ${orgId})                                                              AS automations,
        (SELECT COUNT(*)::int FROM sign_envelopes WHERE org_id = ${orgId})                                                              AS "signEnvelopes",
        (SELECT COUNT(*)::int FROM survey_forms WHERE org_id = ${orgId})                                                                AS surveys,
        (SELECT COUNT(*)::int FROM invoices WHERE org_id = ${orgId})                                                                  AS "acctInvoices",
        (SELECT COUNT(*)::int FROM candidates WHERE org_id = ${orgId})                                                                  AS "hrCandidates",
        (SELECT COUNT(*)::int FROM job_postings WHERE org_id = ${orgId})                                                                AS "hrJobPostings"
    `);
    const counts = {} as Record<LimitKey, number>;
    for (const key of Object.keys(LIMIT_KEY_LABELS) as LimitKey[]) counts[key] = readCount(rows, key);
    return counts;
  } catch (err: unknown) {
    deps.logger.error(`Usage count query failed`, { orgId, cause: err instanceof Error ? err.message : String(err) });
    throw new ServiceUnavailableException("Plan usage could not be determined. The write is refused until usage is verifiable.");
  }
}

export async function fetchCount(
  deps: PlanLimitCountDeps,
  orgId: string,
  key: LimitKey,
  executor?: DbOrTx,
): Promise<number> {
  switch (key) {
    case "members": {
      const rows = await (executor ?? deps.db).execute(sql`SELECT ${seatCount(orgId)} AS count`);
      return readCount(rows, "count");
    }
    case "projects": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM build.projects WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "kbPages": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kb_pages WHERE org_id = ${orgId} AND deleted_at IS NULL`,
      );
      return readCount(rows, "count");
    }
    case "chatChannels": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM chat_channels WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "crmLeads": {
      const rows = await deps.db.execute(
        sql`SELECT (${liveCustomerCount(leadPartyMap.partyId, leadPartyMap.organizationId, orgId)}) AS count`,
      );
      return readCount(rows, "count");
    }
    case "crmContacts": {
      const rows = await deps.db.execute(
        sql`SELECT (${liveCustomerCount(contactPartyMap.partyId, contactPartyMap.organizationId, orgId)}) AS count`,
      );
      return readCount(rows, "count");
    }
    case "crmDeals": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM deals WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "supportTickets": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM support_tickets WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "automations": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM automation_rules WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "signEnvelopes": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM sign_envelopes WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "surveys": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM survey_forms WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "acctInvoices": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM invoices WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "hrCandidates": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM candidates WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
    case "hrJobPostings": {
      const rows = await deps.db.execute(
        sql`SELECT COUNT(*)::int AS count FROM job_postings WHERE org_id = ${orgId}`,
      );
      return readCount(rows, "count");
    }
  }
}
