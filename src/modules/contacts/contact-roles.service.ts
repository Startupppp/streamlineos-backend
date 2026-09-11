import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { crmContactRoles } from "../../db/schema";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CONTACT_ROLE_DEFAULTS, type ContactRoleCreateInput, type DuplicatesQueryInput, type MergeContactsInput } from "./dto/contact-roles.schemas";
import {
  getDuplicateContacts,
  mergeContacts,
  type ContactDuplicateDeps,
} from "./lib/contact-duplicates";
import {
  CONTACT_PARTY_COLUMNS,
  CONTACT_PARTY_JOIN,
  contactIdIs,
  contactPartyScope,
} from "./contact-party-reader";

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

  /** @see lib/contact-duplicates.ts */
  async getDuplicateContacts(orgId: string, query: DuplicatesQueryInput) {
    return getDuplicateContacts(this.duplicateDeps, orgId, query);
  }

  /** @see lib/contact-duplicates.ts */
  async mergeContacts(orgId: string, input: MergeContactsInput, actorId: string) {
    return mergeContacts(this.duplicateDeps, orgId, input, actorId);
  }

  private get duplicateDeps(): ContactDuplicateDeps {
    return { db: this.db, audit: this.audit, cache: this.cache };
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
