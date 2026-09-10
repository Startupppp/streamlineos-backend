import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import type { ScopedRead } from "../../access/scoped-read";
import {
  organizationMembers,
  performanceImprovementPlans,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreatePipInput,
  UpdatePipInput,
} from "./dto/performance.schemas";

@Injectable()
export class PerformancePipsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listPips(read: ScopedRead) {
    return read.read(
      {
        tenant: performanceImprovementPlans.orgId,
        scope: { columns: { ownerColumn: performanceImprovementPlans.userId } },
      },
      ({ sql: where }) =>
        this.db.query.performanceImprovementPlans.findMany({
          where,
          with: {
            user: { columns: { id: true, name: true, image: true } },
            manager: { columns: { id: true, name: true } },
            hrRep: { columns: { id: true, name: true } },
          },
          orderBy: [desc(performanceImprovementPlans.createdAt)],
          limit: 100,
        }),
      () => [],
    );
  }

  async createPip(orgId: string, managerId: string, input: CreatePipInput) {
    await this.assertOrgMember(orgId, input.userId);

    const [pip] = await this.db
      .insert(performanceImprovementPlans)
      .values({
        orgId,
        userId: input.userId,
        managerId,
        hrRepId: input.hrRepId || null,
        reason: input.reason,
        objectives: input.objectives,
        startDate: input.startDate,
        endDate: input.endDate,
        notes: input.notes,
        status: "ACTIVE",
      })
      .returning();

    return pip;
  }

  async updatePip(orgId: string, pipId: number, input: UpdatePipInput) {
    const [updated] = await this.db
      .update(performanceImprovementPlans)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.objectives !== undefined && { objectives: input.objectives }),
        ...(input.hrRepId !== undefined && { hrRepId: input.hrRepId }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(performanceImprovementPlans.id, pipId),
          eq(performanceImprovementPlans.orgId, orgId),
        ),
      )
      .returning({ id: performanceImprovementPlans.id });

    if (!updated)
      throw new NotFoundException("Performance improvement plan not found");

    return { success: true };
  }

  private async assertOrgMember(orgId: string, userId: string): Promise<void> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });
    if (!member)
      throw new NotFoundException("Employee not found in your organization.");
  }
}
