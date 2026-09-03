import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  kpiDefinitions,
  competencyFrameworks,
  competencies,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { hasPatchValues } from "../../../common/db/patch-values";

@Injectable()
export class KpisService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listKpis(orgId: string) {
    return this.db
      .select()
      .from(kpiDefinitions)
      .where(
        and(eq(kpiDefinitions.orgId, orgId), eq(kpiDefinitions.isActive, true)),
      )
      .limit(100);
  }

  createKpi(
    orgId: string,
    data: {
      name: string;
      category: string;
      description?: string;
      unit?: string;
      target?: string;
      weight?: string;
    },
  ) {
    return this.db
      .insert(kpiDefinitions)
      .values({ orgId, ...data })
      .returning();
  }

  async updateKpi(
    orgId: string,
    id: number,
    data: Partial<{
      name: string;
      category: string;
      description: string;
      unit: string;
      target: string;
      weight: string;
      isActive: boolean;
    }>,
  ) {
    const existing = await this.db
      .select({ id: kpiDefinitions.id })
      .from(kpiDefinitions)
      .where(and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.orgId, orgId)))
      .limit(1);

    if (existing.length === 0) throw new NotFoundException("KPI not found.");

    const scope = and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.orgId, orgId));
    if (!hasPatchValues(data)) return this.db.select().from(kpiDefinitions).where(scope);

    return this.db.update(kpiDefinitions).set(data).where(scope).returning();
  }

  async deleteKpi(orgId: string, id: number) {
    const existing = await this.db
      .select({ id: kpiDefinitions.id })
      .from(kpiDefinitions)
      .where(and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.orgId, orgId)))
      .limit(1);

    if (existing.length === 0) throw new NotFoundException("KPI not found.");

    await this.db
      .delete(kpiDefinitions)
      .where(and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.orgId, orgId)));

    return { success: true };
  }

  listFrameworks(orgId: string) {
    return this.db.query.competencyFrameworks.findMany({
      limit: 100,
      where: eq(competencyFrameworks.orgId, orgId),
      with: { competencies: true },
    });
  }

  createFramework(
    orgId: string,
    data: {
      name: string;
      description?: string;
      ratingScale?: number;
      levels?: { level: number; label: string; description: string }[];
    },
  ) {
    return this.db
      .insert(competencyFrameworks)
      .values({ orgId, ...data })
      .returning();
  }

  async updateFramework(
    orgId: string,
    id: number,
    data: Partial<{
      name: string;
      description: string;
      ratingScale: number;
      levels: { level: number; label: string; description: string }[];
    }>,
  ) {
    const existing = await this.db
      .select({ id: competencyFrameworks.id })
      .from(competencyFrameworks)
      .where(
        and(
          eq(competencyFrameworks.id, id),
          eq(competencyFrameworks.orgId, orgId),
        ),
      )
      .limit(1);

    if (existing.length === 0)
      throw new NotFoundException("Framework not found.");

    const scope = and(eq(competencyFrameworks.id, id), eq(competencyFrameworks.orgId, orgId));
    if (!hasPatchValues(data)) return this.db.select().from(competencyFrameworks).where(scope);

    return this.db.update(competencyFrameworks).set(data).where(scope).returning();
  }

  async listCompetencies(orgId: string, frameworkId: number) {
    const framework = await this.db
      .select({ id: competencyFrameworks.id })
      .from(competencyFrameworks)
      .where(
        and(
          eq(competencyFrameworks.id, frameworkId),
          eq(competencyFrameworks.orgId, orgId),
        ),
      )
      .limit(1);
    if (framework.length === 0)
      throw new NotFoundException("Framework not found.");
    return this.db
      .select()
      .from(competencies)
      .where(eq(competencies.frameworkId, frameworkId))
      .limit(500);
  }

  async createCompetency(
    orgId: string,
    frameworkId: number,
    data: {
      name: string;
      category: string;
      description?: string;
      weight?: string;
    },
  ) {
    const framework = await this.db
      .select({ id: competencyFrameworks.id })
      .from(competencyFrameworks)
      .where(
        and(
          eq(competencyFrameworks.id, frameworkId),
          eq(competencyFrameworks.orgId, orgId),
        ),
      )
      .limit(1);
    if (framework.length === 0)
      throw new NotFoundException("Framework not found.");
    return this.db
      .insert(competencies)
      .values({ orgId, frameworkId, ...data })
      .returning();
  }
}
