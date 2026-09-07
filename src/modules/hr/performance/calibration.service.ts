import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and, asc, gt } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrCalibrationEntries, reviewCycles, performanceReviews } from "../../../db/schema/hr/performance";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../hr-read-limits";

@Injectable()
export class CalibrationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertCycle(orgId: string, cycleId: number) {
    const cycle = await this.db.query.reviewCycles.findFirst({
      columns: { id: true },
      where: and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)),
    });
    if (!cycle) throw new NotFoundException("Review cycle not found");
  }

  /** Walks the whole cycle in capped keyset pages — a 9-box grid missing rows is wrong data, not a short page. */
  private async scanAll<TRow extends { id: number }>(
    page: (afterId: number) => Promise<TRow[]>,
  ): Promise<TRow[]> {
    const rows: TRow[] = [];
    let afterId = 0;
    for (let scanned = 0; scanned < HR_SCAN_MAX_PAGES; scanned++) {
      const chunk = await page(afterId);
      rows.push(...chunk);
      if (chunk.length < HR_SCAN_PAGE) break;
      afterId = chunk[chunk.length - 1].id;
    }
    return rows;
  }

  async listEntries(orgId: string, cycleId: number) {
    await this.assertCycle(orgId, cycleId);
    return this.scanAll((afterId) =>
      this.db
        .select()
        .from(hrCalibrationEntries)
        .where(
          and(
            eq(hrCalibrationEntries.orgId, orgId),
            eq(hrCalibrationEntries.cycleId, cycleId),
            gt(hrCalibrationEntries.id, afterId),
          ),
        )
        .orderBy(asc(hrCalibrationEntries.id))
        .limit(HR_SCAN_PAGE),
    );
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
      .where(
        and(
          eq(hrCalibrationEntries.orgId, orgId),
          eq(hrCalibrationEntries.cycleId, cycleId),
          eq(hrCalibrationEntries.employeeId, employeeId),
        ),
      )
      .limit(1);

    if (existing.length) {
      const [updated] = await this.db
        .update(hrCalibrationEntries)
        .set({ ...data, calibratedBy, updatedAt: new Date() })
        .where(
          and(eq(hrCalibrationEntries.orgId, orgId), eq(hrCalibrationEntries.id, existing[0].id)),
        )
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
    const [entries, reviews] = await Promise.all([
      this.scanAll((afterId) =>
        this.db
          .select({
            id: hrCalibrationEntries.id,
            employeeId: hrCalibrationEntries.employeeId,
            postRating: hrCalibrationEntries.postRating,
            note: hrCalibrationEntries.note,
          })
          .from(hrCalibrationEntries)
          .where(
            and(
              eq(hrCalibrationEntries.orgId, orgId),
              eq(hrCalibrationEntries.cycleId, cycleId),
              gt(hrCalibrationEntries.id, afterId),
            ),
          )
          .orderBy(asc(hrCalibrationEntries.id))
          .limit(HR_SCAN_PAGE),
      ),
      this.scanAll((afterId) =>
        this.db
          .select({
            id: performanceReviews.id,
            userId: performanceReviews.userId,
            overallRating: performanceReviews.overallRating,
          })
          .from(performanceReviews)
          .where(
            and(
              eq(performanceReviews.orgId, orgId),
              eq(performanceReviews.cycleId, cycleId),
              gt(performanceReviews.id, afterId),
            ),
          )
          .orderBy(asc(performanceReviews.id))
          .limit(HR_SCAN_PAGE),
      ),
    ]);

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
