import { and } from "drizzle-orm";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import type { Db } from "../../../../db/drizzle.module";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
} from "../../../leads/lead-party-reader";

export async function loadLeadContext(db: Db, orgId: string, leadId: number) {
  const [row] = await db
    .select({
      id: LEAD_PARTY_COLUMNS.id,
      name: LEAD_PARTY_COLUMNS.name,
      source: LEAD_PARTY_COLUMNS.source,
      priority: LEAD_PARTY_COLUMNS.priority,
      city: LEAD_PARTY_COLUMNS.city,
      company: LEAD_PARTY_COLUMNS.company,
    })
    .from(leadPartyMap)
    .innerJoin(businessParties, LEAD_PARTY_JOIN)
    .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId)))
    .limit(1);
  return row ?? null;
}
