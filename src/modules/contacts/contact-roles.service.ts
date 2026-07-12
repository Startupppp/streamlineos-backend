import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql, desc } from "drizzle-orm";
import { contacts, crmContactRoles, surveyParticipants } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CONTACT_ROLE_DEFAULTS, type ContactRoleCreateInput, type DuplicatesQueryInput, type MergeContactsInput } from "./dto/contact-roles.schemas";

function isDbConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Record<string, unknown>).code === "23505"
  );
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
      if (isDbConflict(err)) {
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

  async getDuplicateContacts(orgId: string, query: DuplicatesQueryInput) {
    const limit = query.limit;
    const offset = (query.page - 1) * query.limit;

    const rows = await this.db.execute(
      sql`
        SELECT c1.id AS id1, c1.name AS name1, c1.email AS email1, c1.phone AS phone1,
               c2.id AS id2, c2.name AS name2, c2.email AS email2, c2.phone AS phone2,
               CASE
                 WHEN c1.email IS NOT NULL AND c1.email = c2.email THEN 'email'
                 WHEN c1.phone IS NOT NULL AND c1.phone = c2.phone THEN 'phone'
                 ELSE 'name'
               END AS match_reason
        FROM contacts c1
        JOIN contacts c2
          ON c1.org_id = c2.org_id
         AND c1.id < c2.id
         AND c1.deleted_at IS NULL
         AND c2.deleted_at IS NULL
         AND (
               (c1.email IS NOT NULL AND c1.email = c2.email)
            OR (c1.phone IS NOT NULL AND c1.phone = c2.phone)
            OR (c1.name ILIKE c2.name)
         )
        WHERE c1.org_id = ${orgId}
        ORDER BY c1.id, c2.id
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

  async mergeContacts(orgId: string, input: MergeContactsInput, actorId: string) {
    const [primary] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.primaryId), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)));

    const [duplicate] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.duplicateId), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)));

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
        await tx
          .update(contacts)
          .set({ ...scalarPatch, updatedAt: new Date() })
          .where(eq(contacts.id, input.primaryId));
      }

      await tx
        .update(crmContactRoles)
        .set({ contactId: input.primaryId })
        .where(and(eq(crmContactRoles.contactId, input.duplicateId), eq(crmContactRoles.orgId, orgId)));

      await tx
        .update(surveyParticipants)
        .set({ contactId: input.primaryId })
        .where(and(eq(surveyParticipants.contactId, input.duplicateId), eq(surveyParticipants.orgId, orgId)));

      await tx
        .update(contacts)
        .set({ deletedAt: new Date(), mergedIntoId: input.primaryId, updatedAt: new Date() })
        .where(eq(contacts.id, input.duplicateId));
    });

    this.audit.log({
      action: "crm.contact.merge",
      userId: actorId,
      orgId,
      targetId: String(input.primaryId),
      targetType: "contact",
      metadata: { primaryId: input.primaryId, duplicateId: input.duplicateId },
    });

    await this.cache.invalidatePattern(`crm:contacts:list:${orgId}:*`);

    return { success: true, primaryId: input.primaryId, mergedId: input.duplicateId };
  }

  private async assertContactAccess(orgId: string, contactId: number) {
    const [row] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)));
    if (!row) throw new NotFoundException("Contact not found");
  }
}
