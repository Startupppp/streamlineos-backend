import { and, eq, inArray, isNull, or, sql, asc, desc, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { businessParties, crmPipelines, subjects } from "../../../db/schema";
import type { PartyFingerprint } from "../../party/party-duplicates";
import type { BlockingKeys } from "./import-plan";

/**
 * The reads a preview makes before it can plan anything.
 *
 * All four answer the same question in four vocabularies: which records already
 * in this organisation could this file be talking about? Kept out of the service
 * because they are queries rather than orchestration, and because the service is
 * long enough that a fifth entity's lookup landing in it would be invisible.
 *
 * Every one of them fetches exactly what the file names rather than a slice of
 * the tenant. That is not an optimisation: "the first ten thousand rows Postgres
 * happened to return" is not a stable set, so a plan built from one could differ
 * between two previews of the same file.
 */

/**
 * How many existing parties one preview will weigh a file against.
 *
 * A ceiling rather than a sample: candidates are fetched by identifier, so a
 * tenant reaches this only by having thousands of parties that genuinely share
 * a tax number, an address or a phone line with the file.
 */
export const MAX_CANDIDATES = 10_000;

/** Identifiers per statement, so a five-thousand-row file is a few queries. */
export const KEYS_PER_QUERY = 500;

/**
 * The normalisations `party-duplicates` compares with, written in SQL.
 *
 * These may be WIDER than their TypeScript counterparts — an extra candidate
 * costs one comparison — but never narrower: a candidate this fails to fetch is
 * a duplicate party created in silence.
 */
const NORMALISED: Readonly<Record<"taxNumber" | "email" | "phone" | "host", SQL>> = {
  taxNumber: sql`upper(regexp_replace(coalesce(${businessParties.taxNumber}, ''), '[^A-Za-z0-9]', '', 'g'))`,
  email: sql`lower(trim(coalesce(${businessParties.email}, '')))`,
  phone: sql`right(regexp_replace(coalesce(${businessParties.phone}, ''), '[^0-9]', '', 'g'), 10)`,
  host: sql`regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(${businessParties.website}, ''))), '^[a-z]+://', ''), '/.*$', ''), '^www\\.', '')`,
};

/**
 * The pipeline a deals import lands in.
 *
 * Nothing in somebody else's export names one of this tenant's pipelines, and
 * a deal with no `pipeline_id` does not appear on any board — so an import
 * that left it null would write records the tenant cannot see. The tenant's
 * own default is the honest answer; where there is no default the first active
 * pipeline is, and where there is no pipeline at all the deals still land with
 * the stage the file gave them.
 */
export async function defaultPipelineId(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const [pipeline] = await db
    .select({ id: crmPipelines.id })
    .from(crmPipelines)
    .where(
      and(
        eq(crmPipelines.orgId, organizationId),
        eq(crmPipelines.isActive, true),
        isNull(crmPipelines.deletedAt),
      ),
    )
    .orderBy(desc(crmPipelines.isDefault), asc(crmPipelines.sortOrder), asc(crmPipelines.id))
    .limit(1);

  return pipeline?.id ?? null;
}

/**
 * The subjects this file's references already name, by reference.
 *
 * Exactly the records the file refers to rather than a slice of the tenant —
 * the same argument `existingFingerprints` makes — and `reference` is compared
 * raw because `uniq_subjects_org_type_reference` is on the raw column, so this
 * is an indexed lookup and it agrees with what the database calls unique.
 */
export async function subjectsByReference(
  db: Db,
  organizationId: string,
  subjectTypeId: string | null,
  references: readonly string[],
): Promise<Record<string, string>> {
  if (!subjectTypeId || references.length === 0) return {};

  const found: Record<string, string> = {};

  for (let index = 0; index < references.length; index += KEYS_PER_QUERY) {
    const rows = await db
      .select({ reference: subjects.reference, subjectId: subjects.subjectId })
      .from(subjects)
      .where(
        and(
          eq(subjects.organizationId, organizationId),
          eq(subjects.subjectTypeId, subjectTypeId),
          isNull(subjects.deletedAt),
          inArray(subjects.reference, references.slice(index, index + KEYS_PER_QUERY)),
        ),
      );

    for (const row of rows) if (row.reference) found[row.reference] = row.subjectId;
  }

  return found;
}

/**
 * The parties this file names, by folded name.
 *
 * What an activity or a deal hangs off. A name matching MORE than one party is
 * dropped rather than resolved to the first: two companies sharing a name is
 * the case this module already refuses to guess about, and putting somebody's
 * calls on the wrong customer's timeline is exactly that mistake at the scale
 * of a file. The rows are then skipped, visibly, in the preview.
 *
 * `lower(name)` matches `idx_business_parties_org_lower_name` from 0281, so
 * this is an indexed lookup rather than a walk of every party in the tenant.
 */
export async function partiesByName(
  db: Db,
  organizationId: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  if (names.length === 0) return {};

  const folded = sql<string>`lower(${businessParties.name})`;
  const found = new Map<string, string | null>();

  for (let index = 0; index < names.length; index += KEYS_PER_QUERY) {
    const rows = await db
      .select({ key: folded, partyId: businessParties.partyId })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
          inArray(folded, names.slice(index, index + KEYS_PER_QUERY)),
        ),
      );

    // `null` marks a name two parties answer to, which is not an answer.
    for (const row of rows)
      found.set(row.key, found.has(row.key) ? null : row.partyId);
  }

  const resolved: Record<string, string> = {};
  for (const [key, partyId] of found) if (partyId) resolved[key] = partyId;
  return resolved;
}

/**
 * The parties this file could match, projected to what matters.
 *
 * Fetched by identifier rather than as the first ten thousand rows the table
 * happened to return. Postgres does not promise an order without one, and
 * that slice shifts as rows are updated and vacuumed — so the same file
 * previewed twice could plan a row as `update` on Monday and `create` on
 * Tuesday, and quietly grow a second copy of a customer. The determinism the
 * plan is tested for held only for tenants under the cap.
 *
 * `blockingKeysFor` explains why these four identifiers are sufficient rather
 * than merely convenient.
 */
export async function existingFingerprints(
  db: Db,
  organizationId: string,
  keys: BlockingKeys,
): Promise<{ fingerprints: PartyFingerprint[]; truncated: boolean }> {
  const lookups = [
    { expression: NORMALISED.taxNumber, values: keys.taxNumbers },
    { expression: NORMALISED.email, values: keys.emails },
    { expression: NORMALISED.phone, values: keys.phones },
    { expression: NORMALISED.host, values: keys.hosts },
  ].filter((lookup) => lookup.values.length > 0);

  // A file with no identifier in it cannot match anything, so there is
  // nothing to compare against and no query worth issuing.
  if (lookups.length === 0) return { fingerprints: [], truncated: false };

  const found = new Map<string, PartyFingerprint>();
  const passes = Math.max(
    ...lookups.map((lookup) => Math.ceil(lookup.values.length / KEYS_PER_QUERY)),
  );

  for (let pass = 0; pass < passes && found.size <= MAX_CANDIDATES; pass += 1) {
    const conditions = lookups
      .map((lookup) => ({
        expression: lookup.expression,
        slice: lookup.values.slice(pass * KEYS_PER_QUERY, (pass + 1) * KEYS_PER_QUERY),
      }))
      .filter((lookup) => lookup.slice.length > 0)
      .map((lookup) => inArray(lookup.expression, [...lookup.slice]));

    if (conditions.length === 0) continue;

    const rows = await db
      .select({
        partyId: businessParties.partyId,
        name: businessParties.name,
        legalName: businessParties.legalName,
        email: businessParties.email,
        phone: businessParties.phone,
        taxNumber: businessParties.taxNumber,
        website: businessParties.website,
      })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
          or(...conditions),
        ),
      )
      // One past the ceiling, so "there are more" is known rather than guessed.
      .limit(MAX_CANDIDATES + 1 - found.size);

    for (const party of rows) found.set(party.partyId, party);
  }

  return {
    fingerprints: [...found.values()].slice(0, MAX_CANDIDATES),
    truncated: found.size > MAX_CANDIDATES,
  };
}
