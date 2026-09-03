import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql, desc } from "drizzle-orm";
import { crmContactRoles, surveyParticipants } from "../../db/schema";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { CONTACT_ROLE_DEFAULTS, type ContactRoleCreateInput, type DuplicatesQueryInput, type MergeContactsInput } from "./dto/contact-roles.schemas";
import { updateMirroredContacts } from "../party/party-legacy-contacts";
import { employerLegacyIds } from "../party/party-legacy-employer";
import {
  CONTACT_PARTY_COLUMNS,
  CONTACT_PARTY_JOIN,
  contactIdIs,
  contactPartyScope,
} from "./contact-party-reader";
import { isUniqueViolation } from "../../common/db/postgres-error";
import { buildListResponse, paginateOffset, type ListResponse } from "../../common/pagination/pagination";

interface DuplicateContactSide {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface DuplicateContactPair {
  contact1: DuplicateContactSide;
  contact2: DuplicateContactSide;
  matchReason: string;
}

@Injectable()
export class ContactRolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listRoles(orgId: string, contactId: number, input: { entityType?: string; entityId?: number }) {
    await this.assertContactAccess(orgId, contactId);
    const conditions = [
      eq(crmContactRoles.orgId, orgId),
      eq(crmContactRoles.contactId, contactId),
    ];
    if (input.entityType) conditions.push(eq(crmContactRoles.entityType, input.entityType));
    if (input.entityId) conditions.push(eq(crmContactRoles.entityId, input.entityId));
    return this.db
      .select()
      .from(crmContactRoles)
      .where(and(...conditions))
      .orderBy(desc(crmContactRoles.createdAt));
  }

  async addRole(orgId: string, contactId: number, input: ContactRoleCreateInput, actorId: string) {
    await this.assertContactAccess(orgId, contactId);

    const validKeys = [...CONTACT_ROLE_DEFAULTS, input.roleKey];
    if (!validKeys.includes(input.roleKey as never)) {
      throw new ConflictException(`Unknown role key: ${input.roleKey}`);
    }

    try {
      const [role] = await this.db
        .insert(crmContactRoles)
        .values({
          orgId,
          contactId,
          entityType: input.entityType,
          entityId: input.entityId,
          roleKey: input.roleKey,
          isPrimary: input.isPrimary,
        })
        .returning();

      this.audit.log({
        action: "crm.contact_role.add",
        userId: actorId,
        orgId,
        targetId: String(contactId),
        targetType: "contact",
        metadata: { roleKey: input.roleKey, entityType: input.entityType, entityId: input.entityId },
      });

      return role;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("This role already exists for this contact on this entity");
      }
      throw err;
    }
  }

  async removeRole(orgId: string, contactId: number, roleId: string, actorId: string) {
    await this.assertContactAccess(orgId, contactId);

    const [deleted] = await this.db
      .delete(crmContactRoles)
      .where(
        and(
          eq(crmContactRoles.id, roleId),
          eq(crmContactRoles.orgId, orgId),
          eq(crmContactRoles.contactId, contactId),
        ),
      )
      .returning({ id: crmContactRoles.id });

    if (!deleted) throw new NotFoundException("Role not found");

    this.audit.log({
      action: "crm.contact_role.remove",
      userId: actorId,
      orgId,
      targetId: String(contactId),
      targetType: "contact",
      metadata: { roleId },
    });

    return { success: true };
  }

  async getDuplicateContacts(
    orgId: string,
    query: DuplicatesQueryInput,
  ): Promise<ListResponse<DuplicateContactPair>> {
    const { limit, offset } = paginateOffset({ page: query.page, pageSize: query.limit });

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
    // One definition of "a duplicate pair", shared by the page and the count, so the two can
    // never disagree about what they are counting.
    const pairs = sql`
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
    `;

    const [rows, totals] = await Promise.all([
      this.db.execute(
        sql`
        SELECT m1.contact_id AS id1, p1.name AS name1, p1.email AS email1, p1.phone AS phone1,
               m2.contact_id AS id2, p2.name AS name2, p2.email AS email2, p2.phone AS phone2,
               CASE
                 WHEN p1.email IS NOT NULL AND p1.email = p2.email THEN 'email'
                 WHEN p1.phone IS NOT NULL AND p1.phone = p2.phone THEN 'phone'
                 ELSE 'name'
               END AS match_reason
        ${pairs}
        ORDER BY m1.contact_id, m2.contact_id
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      ),
      this.db.execute(sql`SELECT COUNT(*) AS total ${pairs}`),
    ]);

    const items = rows.map((row) => ({
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

    return buildListResponse(items, Number(totals[0]?.["total"] ?? 0), {
      page: query.page,
      pageSize: query.limit,
    });
  }

  async mergeContacts(orgId: string, input: MergeContactsInput, actorId: string) {
    const [primary, duplicate] = await Promise.all([
      this.mergeCandidate(orgId, input.primaryId),
      this.mergeCandidate(orgId, input.duplicateId),
    ]);

    if (!primary) throw new NotFoundException("Primary contact not found in this org");
    if (!duplicate) throw new NotFoundException("Duplicate contact not found in this org");
    if (primary.orgId !== orgId || duplicate.orgId !== orgId) {
      throw new ForbiddenException("Cross-org merge not allowed");
    }

    await this.db.transaction(async (tx) => {
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

    this.audit.log({
      action: "crm.contact.merge",
      userId: actorId,
      orgId,
      targetId: String(input.primaryId),
      targetType: "contact",
      metadata: { primaryId: input.primaryId, duplicateId: input.duplicateId },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));

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
  private async mergeCandidate(orgId: string, contactId: number) {
    const [row] = await this.db
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
      ? await employerLegacyIds(this.db, orgId, [row.employerPartyId])
      : null;
    return {
      ...row,
      organizationId: row.employerPartyId
        ? (legacy?.get(row.employerPartyId) ?? null)
        : null,
    };
  }

  private async assertContactAccess(orgId: string, contactId: number) {
    const [row] = await this.db
      .select({ id: CONTACT_PARTY_COLUMNS.id })
      .from(contactPartyMap)
      .innerJoin(businessParties, CONTACT_PARTY_JOIN)
      .where(and(...contactPartyScope(orgId), contactIdIs(contactId)));
    if (!row) throw new NotFoundException("Contact not found");
  }
}
