import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import type { CreateOrganizationInput } from "./dto/organization.schemas";

@Injectable()
export class OrgProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listUserOrganizations(userId: string) {
    const memberships = await this.db
      .select({
        orgId: organizationMembers.orgId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .orderBy(desc(organizationMembers.joinedAt));

    if (memberships.length === 0) return [];

    const orgIds = memberships.map((m) => m.orgId);
    const orgs = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    const orgMap = new Map(orgs.map((o) => [o.id, o]));

    return memberships.map((m) => {
      const org = orgMap.get(m.orgId);
      return {
        id: org?.id ?? m.orgId,
        name: org?.name ?? "Unknown",
        slug: org?.slug ?? "",
        role: m.role,
        joinedAt: m.joinedAt,
      };
    });
  }

  async switchOrg(userId: string, targetOrgId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, targetOrgId),
      ),
      columns: { role: true },
    });
    if (!membership)
      throw new BadRequestException(
        "You are not a member of this organization",
      );

    const [org] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
      })
      .from(organizations)
      .where(eq(organizations.id, targetOrgId))
      .limit(1);
    if (!org) throw new BadRequestException("Organization not found");

    await this.db
      .update(users)
      .set({ lastActiveOrgId: targetOrgId })
      .where(eq(users.id, userId));

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    this.audit.log({ action: "org.switched", userId, orgId: targetOrgId });

    return {
      orgId: org.id,
      name: org.name,
      slug: org.slug,
      role: membership.role,
    };
  }

  async createOrganization(userId: string, input: CreateOrganizationInput) {
    const [existing] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.slug))
      .limit(1);

    if (existing)
      throw new ConflictException("Organization slug already exists");

    const orgId = randomUUID();

    let billingEmail: string | null = input.billingEmail ?? null;
    if (!billingEmail) {
      const [actor] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      billingEmail = actor?.email ?? null;
    }

    await this.db.transaction(async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.id);
      if (!Number.isInteger(ownerMembershipId)) {
        throw new Error("Failed to allocate owner membership id");
      }
      await tx.insert(organizations).values({
        id: orgId,
        name: input.name,
        slug: input.slug,
        billingEmail,
        ownerMembershipId,
      });
      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        userId,
        orgId,
        role: "OWNER",
        isOwner: true,
        status: "ACTIVE",
        activatedAt: new Date(),
      });
    });

    return { id: orgId, name: input.name, slug: input.slug };
  }

  async getProfile(userId: string, orgId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        role: organizationMembers.role,
      })
      .from(users)
      .innerJoin(organizationMembers, and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)))
      .where(eq(users.id, userId));

    if (!user) return null;

    const [organization] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    const [membership] = await this.db
      .select({
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
        ),
      );

    return {
      user,
      organization: organization ?? null,
      membership: membership ?? null,
    };
  }
}
