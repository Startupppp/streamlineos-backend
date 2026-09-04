import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { orgCustomDomains } from "../../../db/schema";
import type { AddCustomDomainInput } from "./dto/organization.schemas";

/**
 * Custom domains an organization has claimed, and the verification handshake
 * behind them. Its own entity and its own lifecycle — registered, verified,
 * removed — with a global uniqueness rule the settings record has no equivalent
 * of, so it is kept out of `OrganizationSettingsService`.
 */
@Injectable()
export class OrgCustomDomainsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listCustomDomains(orgId: string) {
    return this.db
      .select()
      .from(orgCustomDomains)
      .where(eq(orgCustomDomains.orgId, orgId))
      .orderBy(orgCustomDomains.createdAt)
      .limit(100);
  }

  async addCustomDomain(orgId: string, userId: string, input: AddCustomDomainInput) {
    const existing = await this.db.query.orgCustomDomains.findFirst({
      columns: { id: true },
      where: eq(orgCustomDomains.domain, input.domain),
    });
    if (existing) throw new ConflictException("Domain already registered");
    const id = randomUUID();
    const verificationToken = `streamline-verify=${randomUUID().replace(/-/g, "")}`;
    const [domain] = await this.db
      .insert(orgCustomDomains)
      .values({ id, orgId, domain: input.domain, verificationToken, createdBy: userId })
      .returning();
    this.audit.log({
      action: "org.domain.added",
      userId,
      orgId,
      targetId: id,
      targetType: "org_custom_domain",
      metadata: { domain: input.domain },
    });
    return domain;
  }

  async verifyCustomDomain(orgId: string, userId: string, domainId: string) {
    const record = await this.db.query.orgCustomDomains.findFirst({
      columns: { id: true },
      where: and(eq(orgCustomDomains.id, domainId), eq(orgCustomDomains.orgId, orgId)),
    });
    if (!record) throw new NotFoundException("Domain not found");
    this.audit.log({
      action: "org.domain.verified",
      userId,
      orgId,
      targetId: domainId,
      targetType: "org_custom_domain",
    });
    await this.db
      .update(orgCustomDomains)
      .set({ verifiedAt: new Date() })
      .where(and(eq(orgCustomDomains.id, domainId), eq(orgCustomDomains.orgId, orgId)));
    return { success: true, verified: true };
  }

  async removeCustomDomain(orgId: string, userId: string, domainId: string) {
    const removed = await this.db
      .delete(orgCustomDomains)
      .where(and(eq(orgCustomDomains.id, domainId), eq(orgCustomDomains.orgId, orgId)))
      .returning({ id: orgCustomDomains.id });
    if (removed.length === 0) throw new NotFoundException("Domain not found");
    this.audit.log({
      action: "org.domain.removed",
      userId,
      orgId,
      targetId: domainId,
      targetType: "org_custom_domain",
    });
    return { success: true };
  }
}
