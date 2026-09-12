import { and, count, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_LEAD } from "../../crm-party-reads";
import { OFFENDER_LIMIT, type DataQualityAggregate } from "./data-quality-shapes";

/** JavaScript's `\s`, by code point: tab through carriage return, space, and the Unicode spaces. */
const JS_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/**
 * A plausible phone number, as a Postgres regular expression: seven to twenty
 * characters, each a `+`, a digit, whitespace, `-`, `(`, `)` or `.`.
 *
 * This replaced `/^[+\d\s\-().]{7,20}$/`, which ran in JavaScript over every lead
 * in the organisation, and it cannot be the same text: Postgres resolves `\d` and
 * `\s` through the collation, where JavaScript's are fixed. Measured over every
 * code point, the verbatim pattern disagreed with JavaScript under each collation
 * tried — `C` rejects a no-break space, ICU and libc `en_US.UTF-8` accept
 * Arabic-Indic digits, `pg_c_utf8` accepts NEL. Spelling both classes out makes
 * the answer independent of the database's locale and identical to the old
 * regex; `data-quality-leads.db.spec.ts` holds it there.
 */
export const PHONE_BASIC_PATTERN = `^[-+0-9().${String.fromCodePoint(...JS_WHITESPACE)}]{7,20}$`;

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
  const where = and(
    eq(leadPartyMap.organizationId, orgId),
    isNull(businessParties.deletedAt),
    isNotNull(businessParties.phone),
    ne(businessParties.phone, ""),
    sql`${businessParties.phone} !~ ${PHONE_BASIC_PATTERN}`,
  );
  const [countRow] = await db
    .select({ n: count() })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(where);
  const offenderRows = await db
    .select({ id: leadPartyMap.leadId, name: businessParties.name, phone: businessParties.phone })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(where)
    .orderBy(desc(businessParties.createdAt))
    .limit(OFFENDER_LIMIT);
  return {
    count: Number(countRow?.n ?? 0),
    offenders: offenderRows.map((r) => ({ id: r.id, name: r.name, detail: r.phone ?? undefined })),
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
