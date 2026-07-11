import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrAccessProvisioning,
  hrAccessProvisioningTemplates,
} from "../../../db/schema/hr/enterprise-ops";
import type {
  CreateProvisioningInput,
  UpdateProvisioningInput,
  ListProvisioningInput,
  CreateTemplateInput,
  UpdateTemplateInput,
  GenerateProvisioningInput,
} from "../dto/identity.schemas";

export type SystemConfig = { systemName: string; action: "grant" | "revoke" | "review" };

@Injectable()
export class IdentityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listProvisioning(orgId: string, input: ListProvisioningInput) {
    const { page, limit, userId, triggeredBy, status } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrAccessProvisioning.orgId, orgId)];
    if (userId) conditions.push(eq(hrAccessProvisioning.userId, userId));
    if (triggeredBy) conditions.push(eq(hrAccessProvisioning.triggeredBy, triggeredBy));
    if (status) conditions.push(eq(hrAccessProvisioning.status, status));

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrAccessProvisioning)
        .where(where)
        .orderBy(desc(hrAccessProvisioning.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrAccessProvisioning).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async createProvisioning(orgId: string, input: CreateProvisioningInput) {
    const [row] = await this.db
      .insert(hrAccessProvisioning)
      .values({ orgId, ...input, requestedAt: new Date() })
      .returning();
    return row;
  }

  async updateProvisioning(orgId: string, id: string, input: UpdateProvisioningInput) {
    const [row] = await this.db
      .update(hrAccessProvisioning)
      .set({
        ...input,
        completedAt: input.completedAt ? new Date(input.completedAt) : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(hrAccessProvisioning.orgId, orgId), eq(hrAccessProvisioning.id, id)))
      .returning();
    if (!row) throw new NotFoundException("Provisioning record not found");
    return row;
  }

  async listTemplates(orgId: string) {
    return this.db
      .select()
      .from(hrAccessProvisioningTemplates)
      .where(eq(hrAccessProvisioningTemplates.orgId, orgId))
      .orderBy(hrAccessProvisioningTemplates.name);
  }

  async createTemplate(orgId: string, input: CreateTemplateInput) {
    const [row] = await this.db
      .insert(hrAccessProvisioningTemplates)
      .values({ orgId, ...input, systemsConfig: input.systemsConfig as unknown })
      .returning();
    return row;
  }

  async updateTemplate(orgId: string, id: string, input: UpdateTemplateInput) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch["name"] = input.name;
    if (input.triggeredBy !== undefined) patch["triggeredBy"] = input.triggeredBy;
    if (input.systemsConfig !== undefined) patch["systemsConfig"] = input.systemsConfig;

    const [row] = await this.db
      .update(hrAccessProvisioningTemplates)
      .set(patch as typeof hrAccessProvisioningTemplates.$inferInsert)
      .where(and(eq(hrAccessProvisioningTemplates.orgId, orgId), eq(hrAccessProvisioningTemplates.id, id)))
      .returning();
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }

  async deleteTemplate(orgId: string, id: string) {
    const result = await this.db
      .delete(hrAccessProvisioningTemplates)
      .where(and(eq(hrAccessProvisioningTemplates.orgId, orgId), eq(hrAccessProvisioningTemplates.id, id)))
      .returning({ id: hrAccessProvisioningTemplates.id });
    if (!result.length) throw new NotFoundException("Template not found");
  }

  async generateProvisioning(orgId: string, input: GenerateProvisioningInput) {
    const templates = await this.db
      .select()
      .from(hrAccessProvisioningTemplates)
      .where(
        and(
          eq(hrAccessProvisioningTemplates.orgId, orgId),
          eq(hrAccessProvisioningTemplates.triggeredBy, input.triggeredBy),
        ),
      );

    const records: typeof hrAccessProvisioning.$inferInsert[] = [];

    for (const tmpl of templates) {
      const systems = (tmpl.systemsConfig ?? []) as SystemConfig[];
      for (const sys of systems) {
        records.push({
          orgId,
          userId: input.userId,
          systemName: sys.systemName,
          action: sys.action,
          triggeredBy: input.triggeredBy,
          status: "pending",
          requestedAt: new Date(),
        });
      }
    }

    if (records.length === 0) return { generated: 0 };

    const rows = await this.db.insert(hrAccessProvisioning).values(records).returning();
    return { generated: rows.length, records: rows };
  }

  async getExitVerification(orgId: string, userId: string) {
    const pendingRevokes = await this.db
      .select()
      .from(hrAccessProvisioning)
      .where(
        and(
          eq(hrAccessProvisioning.orgId, orgId),
          eq(hrAccessProvisioning.userId, userId),
          eq(hrAccessProvisioning.action, "revoke"),
          eq(hrAccessProvisioning.triggeredBy, "leaver"),
        ),
      );

    const unverified = pendingRevokes.filter(
      (r) => r.status !== "verified" && r.status !== "completed",
    );

    return {
      userId,
      hasUnverifiedRevokes: unverified.length > 0,
      unverified,
      total: pendingRevokes.length,
    };
  }

  async hasUnverifiedRevokes(orgId: string, userId: string): Promise<boolean> {
    const result = await this.getExitVerification(orgId, userId);
    return result.hasUnverifiedRevokes;
  }
}
