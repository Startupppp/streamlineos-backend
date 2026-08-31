import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { users } from "../../../db/schema/common/auth";
import { hrPayrollInputSnapshots } from "../../../db/schema/payroll/input-capture";
import type { SectionQueryInput } from "./dto/payroll-inputs.schemas";

@Injectable()
export class PayrollInputSnapshotsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async buildFreezeSummary(orgId: string, periodId: number) {
    const empty = {
      sections: {} as Record<string, number>,
      employeeCount: 0,
      attendanceRows: 0,
      leaveRows: 0,
      overtimeRows: 0,
      compensationRows: 0,
      approvedRegularizations: 0,
    };

    try {
      const rows = await this.db
        .select({
          section: hrPayrollInputSnapshots.section,
          userId: hrPayrollInputSnapshots.userId,
          payload: hrPayrollInputSnapshots.payload,
        })
        .from(hrPayrollInputSnapshots)
        .where(
          and(
            eq(hrPayrollInputSnapshots.orgId, orgId),
            eq(hrPayrollInputSnapshots.periodId, periodId),
          ),
        );

      const sections: Record<string, number> = {};
      const uniqueUsers = new Set<string>();
      let approvedRegularizations = 0;

      for (const row of rows) {
        sections[row.section] = (sections[row.section] ?? 0) + 1;
        uniqueUsers.add(row.userId);
        if (row.section !== "attendance" || !row.payload || typeof row.payload !== "object") continue;
        const approved = Reflect.get(row.payload, "approvedRegularizations");
        if (typeof approved === "number") approvedRegularizations += approved;
        if (typeof approved === "string") approvedRegularizations += Number(approved) || 0;
      }

      return {
        sections,
        employeeCount: uniqueUsers.size,
        attendanceRows: sections.attendance ?? 0,
        leaveRows: sections.leave ?? 0,
        overtimeRows: sections.overtime ?? 0,
        compensationRows: sections.compensation ?? 0,
        approvedRegularizations,
      };
    } catch {
      return empty;
    }
  }

  async listSectionSnapshot(
    orgId: string,
    periodId: number,
    section: typeof hrPayrollInputSnapshots.$inferSelect["section"],
    input: SectionQueryInput,
  ) {
    const offset = (input.page - 1) * input.limit;
    const conditions = [
      eq(hrPayrollInputSnapshots.orgId, orgId),
      eq(hrPayrollInputSnapshots.periodId, periodId),
      eq(hrPayrollInputSnapshots.section, section),
    ];

    const [data, totalResult] = await Promise.all([
      this.db
        .select({
          id: hrPayrollInputSnapshots.id,
          userId: hrPayrollInputSnapshots.userId,
          section: hrPayrollInputSnapshots.section,
          payload: hrPayrollInputSnapshots.payload,
          sourceRefs: hrPayrollInputSnapshots.sourceRefs,
          createdAt: hrPayrollInputSnapshots.createdAt,
          userName: users.name,
          userFirstName: users.firstName,
          userLastName: users.lastName,
          userEmail: users.email,
        })
        .from(hrPayrollInputSnapshots)
        .innerJoin(users, eq(users.id, hrPayrollInputSnapshots.userId))
        .where(and(...conditions))
        .orderBy(desc(hrPayrollInputSnapshots.createdAt), desc(hrPayrollInputSnapshots.id))
        .limit(input.limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrPayrollInputSnapshots).where(and(...conditions)),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return {
      data,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }
}
