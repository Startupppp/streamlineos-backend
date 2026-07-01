import { Injectable } from "@nestjs/common";
import { db } from "../../db";
import { careerPaths, employeeCareerPlans } from "../../db/schema";
import { eq, and } from "drizzle-orm";

@Injectable()
export class CareerService {
  async listPaths(orgId: string) {
    return db.select().from(careerPaths)
      .where(and(eq(careerPaths.orgId, orgId), eq(careerPaths.isActive, true)))
      .orderBy(careerPaths.name)
      .limit(100);
  }

  async createPath(orgId: string, data: typeof careerPaths.$inferInsert) {
    const [path] = await db.insert(careerPaths).values({ ...data, orgId }).returning();
    return path;
  }

  async updatePath(orgId: string, id: number, data: Partial<typeof careerPaths.$inferInsert>) {
    const [path] = await db.update(careerPaths).set(data)
      .where(and(eq(careerPaths.id, id), eq(careerPaths.orgId, orgId))).returning();
    return path;
  }

  async getMyPlan(orgId: string, userId: string) {
    const [plan] = await db.select().from(employeeCareerPlans)
      .where(and(eq(employeeCareerPlans.orgId, orgId), eq(employeeCareerPlans.userId, userId)));
    return plan ?? null;
  }

  async saveMyPlan(orgId: string, userId: string, data: Partial<typeof employeeCareerPlans.$inferInsert>) {
    const existing = await this.getMyPlan(orgId, userId);
    if (existing) {
      const [updated] = await db.update(employeeCareerPlans)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(employeeCareerPlans.orgId, orgId), eq(employeeCareerPlans.userId, userId)))
        .returning();
      return updated;
    }
    const [created] = await db.insert(employeeCareerPlans).values({ ...data, orgId, userId }).returning();
    return created;
  }

  async updateMilestone(orgId: string, userId: string, idx: number, completed: boolean) {
    const plan = await this.getMyPlan(orgId, userId);
    if (!plan) return null;
    const milestones = [...plan.milestones];
    if (milestones[idx]) milestones[idx] = { ...milestones[idx], completed };
    const [updated] = await db.update(employeeCareerPlans)
      .set({ milestones, updatedAt: new Date() })
      .where(and(eq(employeeCareerPlans.orgId, orgId), eq(employeeCareerPlans.userId, userId)))
      .returning();
    return updated;
  }
}
