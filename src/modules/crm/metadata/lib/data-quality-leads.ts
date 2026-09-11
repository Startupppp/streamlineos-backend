import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_LEAD } from "../../crm-party-reads";
import { OFFENDER_LIMIT, type DataQualityAggregate } from "./data-quality-shapes";

const PHONE_BASIC_RE = /^[+\d\s\-().]{7,20}$/;

/**
 * The four checks that are about LEADS.
 *
 * Kept apart from the deal checks because they share the party join — every one
 * of them reaches a lead through `lead_party_map` into `business_parties`, which
 * is the part that has to stay correct as the identity migration proceeds. The
 * deal checks touch none of it.
 */

export async function leadsWithoutEmail(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const where = and(
    eq(leadPartyMap.organizationId, orgId),
    isNull(businessParties.deletedAt),
    isNull(businessParties.email),
  );
  const [countRow] = await db
    .select({ n: count() })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(where);
  const offenderRows = await db
    .select({ id: leadPartyMap.leadId, name: businessParties.name })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(where)
    .orderBy(desc(businessParties.createdAt))
    .limit(OFFENDER_LIMIT);
  return {
    count: Number(countRow?.n ?? 0),
    offenders: offenderRows.map((r) => ({ id: r.id, name: r.name })),
  };
}

export async function leadsWithInvalidPhone(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const rows = await db
    .select({ id: leadPartyMap.leadId, name: businessParties.name, phone: businessParties.phone })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(and(eq(leadPartyMap.organizationId, orgId), isNull(businessParties.deletedAt)))
    .orderBy(desc(businessParties.createdAt));
  const invalid = rows.filter(
    (r) => r.phone !== null && r.phone !== undefined && r.phone !== "" && !PHONE_BASIC_RE.test(r.phone),
  );
  return {
    count: invalid.length,
    offenders: invalid.slice(0, OFFENDER_LIMIT).map((r) => ({ id: r.id, name: r.name, detail: r.phone ?? undefined })),
  };
}

export async function duplicateLeads(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const emailDups = await db.execute(
    sql`
      SELECT p.email,
             string_agg(m.lead_id::text, ',') AS ids,
             string_agg(p.name, ' | ') AS names
      FROM ${leadPartyMap} m
      JOIN ${businessParties} p
        ON p.party_id = m.party_id
       AND p.organization_id = m.organization_id
      WHERE m.organization_id = ${orgId}
        AND p.deleted_at IS NULL
        AND p.email IS NOT NULL
        AND p.email != ''
      GROUP BY p.email
      HAVING count(*) > 1
      LIMIT ${OFFENDER_LIMIT}
    `,
  );
  const phoneDups = await db.execute(
    sql`
      SELECT p.phone,
             string_agg(m.lead_id::text, ',') AS ids,
             string_agg(p.name, ' | ') AS names
      FROM ${leadPartyMap} m
      JOIN ${businessParties} p
        ON p.party_id = m.party_id
       AND p.organization_id = m.organization_id
      WHERE m.organization_id = ${orgId}
        AND p.deleted_at IS NULL
        AND p.phone IS NOT NULL
        AND p.phone != ''
      GROUP BY p.phone
      HAVING count(*) > 1
      LIMIT ${OFFENDER_LIMIT}
    `,
  );
  const emailOffenders = (emailDups as Array<Record<string, unknown>>).map((r) => ({
    id: String(r["ids"] ?? ""),
    name: String(r["names"] ?? ""),
    detail: `Duplicate email: ${String(r["email"] ?? "")}`,
  }));
  const phoneOffenders = (phoneDups as Array<Record<string, unknown>>).map((r) => ({
    id: String(r["ids"] ?? ""),
    name: String(r["names"] ?? ""),
    detail: `Duplicate phone: ${String(r["phone"] ?? "")}`,
  }));
  const offenders = [...emailOffenders, ...phoneOffenders].slice(0, OFFENDER_LIMIT);
  return { count: emailOffenders.length + phoneOffenders.length, offenders };
}

export async function leadsWithNoOwner(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const where = and(
    eq(leadPartyMap.organizationId, orgId),
    isNull(businessParties.deletedAt),
    isNull(businessParties.ownerUserId),
  );
  const [countRow] = await db
    .select({ n: count() })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(where);
  const offenderRows = await db
    .select({ id: leadPartyMap.leadId, name: businessParties.name })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(where)
    .orderBy(desc(businessParties.createdAt))
    .limit(OFFENDER_LIMIT);
  return {
    count: Number(countRow?.n ?? 0),
    offenders: offenderRows.map((r) => ({ id: r.id, name: r.name })),
  };
}
