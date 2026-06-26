import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { crmSla, leads } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { SlaPolicyCreateInput, SlaPolicyUpdateInput } from "./dto/sla.schemas";

@Injectable()
export class CrmSlaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listPolicies(orgId: string) {
    return this.cache.cached(
      `crm:sla-policies:${orgId}`,
      () =>
        this.db
          .select({
            id: crmSla.id,
            name: crmSla.name,
            appliesTo: crmSla.appliesTo,
            priority: crmSla.priority,
            firstResponseHours: crmSla.firstResponseHours,
            resolutionHours: crmSla.resolutionHours,
            createdAt: crmSla.createdAt,
          })
          .from(crmSla)
          .where(eq(crmSla.orgId, orgId))
          .orderBy(desc(crmSla.createdAt))
          .limit(100),
      CACHE_TTL.LONG,
    );
  }

  async createPolicy(orgId: string, input: SlaPolicyCreateInput) {
    const [policy] = await this.db
      .insert(crmSla)
      .values({
        orgId,
        name: input.name,
        appliesTo: input.appliesTo,
        priority: input.priority,
        firstResponseHours: input.firstResponseHours,
        resolutionHours: input.resolutionHours,
      })
      .returning();
    await this.cache.invalidatePattern(`crm:sla-policies:${orgId}*`);
    return policy;
  }

  updatePolicy(orgId: string, id: number, input: SlaPolicyUpdateInput) {
    return this.db
      .update(crmSla)
      .set(input)
      .where(and(eq(crmSla.id, id), eq(crmSla.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deletePolicy(orgId: string, id: number) {
    await this.db.delete(crmSla).where(and(eq(crmSla.id, id), eq(crmSla.orgId, orgId)));
    return { success: true };
  }

  breached(orgId: string) {
    const now = new Date();
    return this.db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        status: leads.status,
        priority: leads.priority,
        slaDeadline: leads.slaDeadline,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          isNotNull(leads.slaDeadline),
          lt(leads.slaDeadline, now),
          sql`${leads.status} NOT IN ('CONVERTED', 'LOST')`,
        ),
      )
      .limit(100);
  }

  async report(orgId: string) {
    const now = new Date();

    const [totals] = await this.db
      .select({ total: count() })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNotNull(leads.slaDeadline)));

    const [breached] = await this.db
      .select({ count: count() })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          isNotNull(leads.slaDeadline),
          sql`${leads.slaDeadline} < ${now.toISOString()}`,
          sql`${leads.status} NOT IN ('CONVERTED', 'LOST')`,
        ),
      );

    const total = totals?.total ?? 0;
    const breachedCount = breached?.count ?? 0;
    const compliant = total - breachedCount;
    const complianceRate = total > 0 ? Math.round((compliant / total) * 100) : 100;

    return { total, compliant, breached: breachedCount, complianceRate };
  }
}
