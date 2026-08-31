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

export const MAX_NOTES = 2000;

export function trunc(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > MAX_NOTES ? s.slice(0, MAX_NOTES) + "…" : s;
}

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

export async function loadLeadProfile(db: Db, orgId: string, leadId: number) {
  const [row] = await db
    .select({
      id: LEAD_PARTY_COLUMNS.id,
      name: LEAD_PARTY_COLUMNS.name,
      email: LEAD_PARTY_COLUMNS.email,
      phone: LEAD_PARTY_COLUMNS.phone,
      company: LEAD_PARTY_COLUMNS.company,
      designation: LEAD_PARTY_COLUMNS.designation,
      city: LEAD_PARTY_COLUMNS.city,
      source: LEAD_PARTY_COLUMNS.source,
      status: LEAD_PARTY_COLUMNS.status,
      priority: LEAD_PARTY_COLUMNS.priority,
      score: LEAD_PARTY_COLUMNS.score,
      potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
      investmentInterest: LEAD_PARTY_COLUMNS.investmentInterest,
      tags: LEAD_PARTY_COLUMNS.tags,
      notes: LEAD_PARTY_COLUMNS.notes,
      followUpNotes: LEAD_PARTY_COLUMNS.followUpNotes,
    })
    .from(leadPartyMap)
    .innerJoin(businessParties, LEAD_PARTY_JOIN)
    .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId)))
    .limit(1);
  return row ?? null;
}
