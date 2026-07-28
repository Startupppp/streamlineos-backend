import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { contacts, crmOrganizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import type { MergeOrgsInput, OrgDuplicatesQueryInput } from "./dto/org-merge.schemas";

@Injectable()
export class CrmOrgMergeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async getDuplicateOrgs(orgId: string, query: OrgDuplicatesQueryInput) {
    const limit = query.limit;
    const offset = (query.page - 1) * query.limit;

    const rows = await this.db.execute(
      sql`
        SELECT o1.id AS id1, o1.name AS name1, o1.domain AS domain1,
               o2.id AS id2, o2.name AS name2, o2.domain AS domain2,
               CASE
                 WHEN o1.domain IS NOT NULL AND o1.domain = o2.domain THEN 'domain'
                 ELSE 'name'
               END AS match_reason
        FROM crm_organizations o1
        JOIN crm_organizations o2
          ON o1.org_id = o2.org_id
         AND o1.id < o2.id
         AND o1.deleted_at IS NULL
         AND o2.deleted_at IS NULL
         AND (
               (o1.domain IS NOT NULL AND o1.domain = o2.domain)
            OR (o1.name ILIKE o2.name)
         )
        WHERE o1.org_id = ${orgId}
        ORDER BY o1.id, o2.id
        LIMIT ${limit}
        OFFSET ${offset}
      `,
    );

    return rows.map((row) => ({
      org1: {
        id: Number(row["id1"]),
        name: String(row["name1"] ?? ""),
        domain: row["domain1"] ? String(row["domain1"]) : null,
      },
      org2: {
        id: Number(row["id2"]),
        name: String(row["name2"] ?? ""),
        domain: row["domain2"] ? String(row["domain2"]) : null,
      },
      matchReason: String(row["match_reason"] ?? "name"),
    }));
  }

  async mergeOrganizations(orgId: string, input: MergeOrgsInput, actorId: string) {
    const [primary] = await this.db
      .select()
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, input.primaryId), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)));

    const [duplicate] = await this.db
      .select()
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, input.duplicateId), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)));

    if (!primary) throw new NotFoundException("Primary organization not found in this org");
    if (!duplicate) throw new NotFoundException("Duplicate organization not found in this org");
    if (primary.orgId !== orgId || duplicate.orgId !== orgId) {
      throw new ForbiddenException("Cross-org merge not allowed");
    }

    await this.db.transaction(async (tx) => {
      const scalarPatch: Record<string, unknown> = {};
      if (!primary.domain && duplicate.domain) scalarPatch.domain = duplicate.domain;
      if (!primary.industry && duplicate.industry) scalarPatch.industry = duplicate.industry;
      if (!primary.website && duplicate.website) scalarPatch.website = duplicate.website;
      if (!primary.linkedinUrl && duplicate.linkedinUrl) scalarPatch.linkedinUrl = duplicate.linkedinUrl;
      if (!primary.description && duplicate.description) scalarPatch.description = duplicate.description;
      if (primary.healthScore === null && duplicate.healthScore !== null) {
        scalarPatch.healthScore = duplicate.healthScore;
      }

      if (Object.keys(scalarPatch).length > 0) {
        await tx
          .update(crmOrganizations)
          .set({ ...scalarPatch, updatedAt: new Date() })
          .where(and(eq(crmOrganizations.id, input.primaryId), eq(crmOrganizations.orgId, orgId)));
      }

      await tx
        .update(contacts)
        .set({ organizationId: input.primaryId, updatedAt: new Date() })
        .where(and(eq(contacts.organizationId, input.duplicateId), eq(contacts.orgId, orgId)));

      await tx
        .update(crmOrganizations)
        .set({ parentId: input.primaryId, updatedAt: new Date() })
        .where(and(eq(crmOrganizations.parentId, input.duplicateId), eq(crmOrganizations.orgId, orgId)));

      await tx
        .update(crmOrganizations)
        .set({ deletedAt: new Date(), mergedIntoId: input.primaryId, updatedAt: new Date() })
        .where(and(eq(crmOrganizations.id, input.duplicateId), eq(crmOrganizations.orgId, orgId)));
    });

    this.audit.log({
      action: "crm.organization.merge",
      userId: actorId,
      orgId,
      targetId: String(input.primaryId),
      targetType: "crm_organization",
      metadata: { primaryId: input.primaryId, duplicateId: input.duplicateId },
    });

    await this.cache.invalidatePattern(`crm:organizations:list:${orgId}:*`);

    return { success: true, primaryId: input.primaryId, mergedId: input.duplicateId };
  }
}
