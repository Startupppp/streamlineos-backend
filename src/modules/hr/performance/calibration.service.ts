import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrCalibrationEntries, reviewCycles, performanceReviews } from "../../../db/schema/hr/performance";

@Injectable()
export class CalibrationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listEntries(orgId: string, cycleId: number) {
    return this.db
      .select()
      .from(hrCalibrationEntries)
      .where(and(eq(hrCalibrationEntries.orgId, orgId), eq(hrCalibrationEntries.cycleId, cycleId)));
  }

  async upsertEntry(
    orgId: string,
    cycleId: number,
    employeeId: string,
    data: { preRating?: string; postRating?: string; note?: string },
    calibratedBy: string,
  ) {
    const cycle = await this.db
      .select({ id: reviewCycles.id })
      .from(reviewCycles)
      .where(and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)))
      .limit(1);
    if (!cycle.length) throw new NotFoundException("Review cycle not found");

    const existing = await this.db
      .select()
      .from(hrCalibrationEntries)
      .where(and(eq(hrCalibrationEntries.cycleId, cycleId), eq(hrCalibrationEntries.employeeId, employeeId)))
      .limit(1);

    if (existing.length) {
      const [updated] = await this.db
        .update(hrCalibrationEntries)
        .set({ ...data, calibratedBy, updatedAt: new Date() })
        .where(eq(hrCalibrationEntries.id, existing[0].id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(hrCalibrationEntries)
      .values({ orgId, cycleId, employeeId, calibratedBy, ...data })
      .returning();
    return created;
  }

  async getNineBox(orgId: string, cycleId: number) {
    const entries = await this.db
      .select({
        employeeId: hrCalibrationEntries.employeeId,
        postRating: hrCalibrationEntries.postRating,
        note: hrCalibrationEntries.note,
      })
      .from(hrCalibrationEntries)
      .where(and(eq(hrCalibrationEntries.orgId, orgId), eq(hrCalibrationEntries.cycleId, cycleId)));

    const reviews = await this.db
      .select({
        userId: performanceReviews.userId,
        overallRating: performanceReviews.overallRating,
      })
      .from(performanceReviews)
      .where(and(eq(performanceReviews.orgId, orgId), eq(performanceReviews.cycleId, cycleId)));

    const reviewMap = new Map(reviews.map((r) => [r.userId, Number(r.overallRating ?? 0)]));

    return entries.map((e) => {
      const performance = reviewMap.get(e.employeeId) ?? 0;
      const potential = Number(e.postRating ?? 0);
      const perfBox = performance <= 2 ? 1 : performance <= 3.5 ? 2 : 3;
      const potBox = potential <= 2 ? 1 : potential <= 3.5 ? 2 : 3;
      return {
        employeeId: e.employeeId,
        performance,
        potential,
        box: `${potBox}-${perfBox}`,
        note: e.note,
      };
    });
  }
}
