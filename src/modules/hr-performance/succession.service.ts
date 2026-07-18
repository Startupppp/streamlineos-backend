import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrSuccessionPlans } from "../../db/schema/hr/succession";

@Injectable()
export class SuccessionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    return this.db.select().from(hrSuccessionPlans).where(eq(hrSuccessionPlans.orgId, orgId));
  }

  async create(
    orgId: string,
    createdBy: string,
    data: {
      roleName: string;
      jobRoleId?: number;
      incumbentId?: string;
      successorId: string;
      readiness: "ready_now" | "1_2_years" | "3_plus";
      note?: string;
    },
  ) {
    const [created] = await this.db
      .insert(hrSuccessionPlans)
      .values({ orgId, createdBy, ...data })
      .returning();
    return created;
  }

  async update(
    orgId: string,
    id: number,
    data: Partial<{
      roleName: string;
      jobRoleId: number;
      incumbentId: string;
      successorId: string;
      readiness: "ready_now" | "1_2_years" | "3_plus";
      note: string;
    }>,
  ) {
    const existing = await this.db
      .select({ id: hrSuccessionPlans.id })
      .from(hrSuccessionPlans)
      .where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)))
      .limit(1);
    if (!existing.length) throw new NotFoundException("Succession plan not found");

    const [updated] = await this.db
      .update(hrSuccessionPlans)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)))
      .returning();
    return updated;
  }

  async remove(orgId: string, id: number) {
    const existing = await this.db
      .select({ id: hrSuccessionPlans.id })
      .from(hrSuccessionPlans)
      .where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)))
      .limit(1);
    if (!existing.length) throw new NotFoundException("Succession plan not found");
    await this.db.delete(hrSuccessionPlans).where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)));
    return { success: true };
  }
}
