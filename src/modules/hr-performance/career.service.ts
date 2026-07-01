import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { careerPaths, employeeCareerPlans } from "../../db/schema";
import { eq, and } from "drizzle-orm";

@Injectable()
export class CareerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPaths(orgId: string) {
    return this.db.select().from(careerPaths)
      .where(and(eq(careerPaths.orgId, orgId), eq(careerPaths.isActive, true)))
      .orderBy(careerPaths.name)
      .limit(100);
  }

  async createPath(orgId: string, data: typeof careerPaths.$inferInsert) {
    const [path] = await this.db.insert(careerPaths).values({ ...data, orgId }).returning();
    return path;
  }

  async updatePath(orgId: string, id: number, data: Partial<typeof careerPaths.$inferInsert>) {
    const [path] = await this.db.update(careerPaths).set(data)
      .where(and(eq(careerPaths.id, id), eq(careerPaths.orgId, orgId))).returning();
    return path;
  }

  async getMyPlan(orgId: string, userId: string) {
    const [plan] = await this.db.select().from(employeeCareerPlans)
      .where(and(eq(employeeCareerPlans.orgId, orgId), eq(employeeCareerPlans.userId, userId)));
    return plan ?? null;
  }

  async saveMyPlan(orgId: string, userId: string, data: Partial<typeof employeeCareerPlans.$inferInsert>) {
    const existing = await this.getMyPlan(orgId, userId);
    if (existing) {
      const [updated] = await this.db.update(employeeCareerPlans)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(employeeCareerPlans.orgId, orgId), eq(employeeCareerPlans.userId, userId)))
        .returning();
      return updated;
    }
    const [created] = await this.db.insert(employeeCareerPlans).values({ ...data, orgId, userId }).returning();
    return created;
  }

  async updateMilestone(orgId: string, userId: string, idx: number, completed: boolean) {
    const plan = await this.getMyPlan(orgId, userId);
    if (!plan) return null;
    const milestones = [...plan.milestones];
    if (milestones[idx]) milestones[idx] = { ...milestones[idx], completed };
    const [updated] = await this.db.update(employeeCareerPlans)
      .set({ milestones, updatedAt: new Date() })
      .where(and(eq(employeeCareerPlans.orgId, orgId), eq(employeeCareerPlans.userId, userId)))
      .returning();
    return updated;
  }
}
