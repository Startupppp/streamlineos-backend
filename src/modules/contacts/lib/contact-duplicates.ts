import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { crmContactRoles, surveyParticipants } from "../../../db/schema";
import { businessParties, contactPartyMap } from "../../../db/schema/party";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { updateMirroredContacts } from "../../party/party-legacy-contacts";
import { employerLegacyIds } from "../../party/party-legacy-employer";
import {
  CONTACT_PARTY_COLUMNS,
  CONTACT_PARTY_JOIN,
  contactIdIs,
  contactPartyScope,
} from "../contact-party-reader";
import type { DuplicatesQueryInput, MergeContactsInput } from "../dto/contact-roles.schemas";

/**
 * Finding duplicate contacts and merging two into one.
 *
 * Split out of `contact-roles.service.ts`, which is named for the other half of
 * what it held: roles on a contact are a small list-add-remove surface, and this
 * is a pair search plus a destructive merge that rewrites party mappings,
 * survey participation and the legacy contact mirror. Nothing here is reachable
 * from the role endpoints and nothing there is reachable from these; they shared
 * a file and not a subject.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface ContactDuplicateDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly cache: CacheService;
}

export async function getDuplicateContacts(
  deps: ContactDuplicateDeps,
  orgId: string, query: DuplicatesQueryInput) {
  const limit = query.limit;
  const offset = (query.page - 1) * query.limit;

  /*
   * The pair search now compares parties, reached through `contact_party_map`
   * so the numeric ids the merge endpoint takes stay selectable. The tenant is
   * asserted on both map rows and carried across both joins, which is stronger
   * than the `c1.org_id = c2.org_id` the legacy self-join relied on -- that one
   * only required the two contacts to agree, not to agree with the caller.
   *
   * The comparison itself is unchanged, deliberately: raw string equality on
   * the display columns. `party_identifiers` is the real matcher now and finds
   * the pairs this cannot -- `Ops@Acme.example` against `ops@acme.example`, a
   * number written with a country code against one without -- so this list
   * should converge on `partiesSharingIdentifiers`. Doing that here would
   * change which duplicates the screen reports, which is its own ticket.
   */
  const rows = await deps.db.execute(
    sql`
      SELECT m1.contact_id AS id1, p1.name AS name1, p1.email AS email1, p1.phone AS phone1,
             m2.contact_id AS id2, p2.name AS name2, p2.email AS email2, p2.phone AS phone2,
             CASE
               WHEN p1.email IS NOT NULL AND p1.email = p2.email THEN 'email'
               WHEN p1.phone IS NOT NULL AND p1.phone = p2.phone THEN 'phone'
               ELSE 'name'
             END AS match_reason
      FROM contact_party_map m1
      JOIN business_parties p1
        ON p1.party_id = m1.party_id
       AND p1.organization_id = m1.organization_id
      JOIN contact_party_map m2
        ON m2.organization_id = m1.organization_id
       AND m2.contact_id > m1.contact_id
      JOIN business_parties p2
        ON p2.party_id = m2.party_id
       AND p2.organization_id = m2.organization_id
      WHERE m1.organization_id = ${orgId}
        AND p1.deleted_at IS NULL
        AND p2.deleted_at IS NULL
        AND (
              (p1.email IS NOT NULL AND p1.email = p2.email)
           OR (p1.phone IS NOT NULL AND p1.phone = p2.phone)
           OR (p1.name ILIKE p2.name)
        )
      ORDER BY m1.contact_id, m2.contact_id
      LIMIT ${limit}
      OFFSET ${offset}
    `,
  );

  return rows.map((row) => ({
    contact1: {
      id: Number(row["id1"]),
      name: String(row["name1"] ?? ""),
      email: row["email1"] ? String(row["email1"]) : null,
      phone: row["phone1"] ? String(row["phone1"]) : null,
    },
    contact2: {
      id: Number(row["id2"]),
      name: String(row["name2"] ?? ""),
      email: row["email2"] ? String(row["email2"]) : null,
      phone: row["phone2"] ? String(row["phone2"]) : null,
    },
    matchReason: String(row["match_reason"] ?? "name"),
  }));
}

export async function mergeContacts(
  deps: ContactDuplicateDeps,
  orgId: string, input: MergeContactsInput, actorId: string) {
  const [primary, duplicate] = await Promise.all([
    mergeCandidate(deps, orgId, input.primaryId),
    mergeCandidate(deps, orgId, input.duplicateId),
  ]);

  if (!primary) throw new NotFoundException("Primary contact not found in this org");
  if (!duplicate) throw new NotFoundException("Duplicate contact not found in this org");
  if (primary.orgId !== orgId || duplicate.orgId !== orgId) {
    throw new ForbiddenException("Cross-org merge not allowed");
  }

  await deps.db.transaction(async (tx) => {
    const scalarPatch: Record<string, unknown> = {};
    if (!primary.email && duplicate.email) scalarPatch.email = duplicate.email;
    if (!primary.phone && duplicate.phone) scalarPatch.phone = duplicate.phone;
    if (!primary.title && duplicate.title) scalarPatch.title = duplicate.title;
    if (!primary.company && duplicate.company) scalarPatch.company = duplicate.company;
    if (!primary.department && duplicate.department) scalarPatch.department = duplicate.department;
    if (!primary.avatarUrl && duplicate.avatarUrl) scalarPatch.avatarUrl = duplicate.avatarUrl;
    if (!primary.linkedinUrl && duplicate.linkedinUrl) scalarPatch.linkedinUrl = duplicate.linkedinUrl;
    if (!primary.twitterUrl && duplicate.twitterUrl) scalarPatch.twitterUrl = duplicate.twitterUrl;
    if (!primary.organizationId && duplicate.organizationId) scalarPatch.organizationId = duplicate.organizationId;

    if (Object.keys(scalarPatch).length > 0) {
      await updateMirroredContacts(tx, orgId, [input.primaryId], {
        ...scalarPatch,
        updatedAt: new Date(),
      });
    }

    await tx
      .update(crmContactRoles)
      .set({ contactId: input.primaryId })
      .where(and(eq(crmContactRoles.contactId, input.duplicateId), eq(crmContactRoles.orgId, orgId)));

    await tx
      .update(surveyParticipants)
      .set({ contactId: input.primaryId })
      .where(and(eq(surveyParticipants.contactId, input.duplicateId), eq(surveyParticipants.orgId, orgId)));

    await updateMirroredContacts(tx, orgId, [input.duplicateId], {
      deletedAt: new Date(),
      mergedIntoId: input.primaryId,
      updatedAt: new Date(),
    });
  });

  deps.audit.log({
    action: "crm.contact.merge",
    userId: actorId,
    orgId,
    targetId: String(input.primaryId),
    targetType: "contact",
    metadata: { primaryId: input.primaryId, duplicateId: input.duplicateId },
  });

  await deps.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));

  return { success: true, primaryId: input.primaryId, mergedId: input.duplicateId };
}

/**
 * The scalars the merge decides on, all read from the party.
 *
 * The patch this feeds is in `contacts`' vocabulary, because that is what
 * `updateMirroredContacts` takes and the writer translates it once -- so the
 * employer comes back as the integer `crm_organizations` id rather than as
 * `employer_party_id`. It is translated here rather than read off the legacy
 * row, through the same `crm_org_party_map` lookup the mirror uses to write
 * that column, so the two cannot give different answers.
 *
 * A party whose employer has no `crm_organizations` row behind it translates to
 * null, which is exactly what `contacts.organization_id` holds for it today --
 * the legacy column cannot name a company the legacy table has never heard of,
 * and `PartyDivergenceService.findEmployerDisagreements` is what reports that
 * gap. So this reads the same value the legacy join did, without the join.
 */
async function mergeCandidate(
  deps: ContactDuplicateDeps,
  orgId: string,
  contactId: number,
) {
  const [row] = await deps.db
    .select({
      id: CONTACT_PARTY_COLUMNS.id,
      orgId: CONTACT_PARTY_COLUMNS.orgId,
      name: CONTACT_PARTY_COLUMNS.name,
      email: CONTACT_PARTY_COLUMNS.email,
      phone: CONTACT_PARTY_COLUMNS.phone,
      title: CONTACT_PARTY_COLUMNS.title,
      company: CONTACT_PARTY_COLUMNS.company,
      department: CONTACT_PARTY_COLUMNS.department,
      avatarUrl: CONTACT_PARTY_COLUMNS.avatarUrl,
      linkedinUrl: CONTACT_PARTY_COLUMNS.linkedinUrl,
      twitterUrl: CONTACT_PARTY_COLUMNS.twitterUrl,
      employerPartyId: businessParties.employerPartyId,
    })
    .from(contactPartyMap)
    .innerJoin(businessParties, CONTACT_PARTY_JOIN)
    .where(and(...contactPartyScope(orgId), contactIdIs(contactId)));
  if (!row) return undefined;

  const legacy = row.employerPartyId
    ? await employerLegacyIds(deps.db, orgId, [row.employerPartyId])
    : null;
  return {
    ...row,
    organizationId: row.employerPartyId
      ? (legacy?.get(row.employerPartyId) ?? null)
      : null,
  };
}
