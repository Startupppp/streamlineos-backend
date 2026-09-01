import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, or, isNull, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrBenefitPlans,
  hrBenefitEnrollmentWindows,
} from "../../../db/schema/hr/benefits";
import type {
  CreateBenefitPlanInput,
  PatchBenefitPlanInput,
  CreateEnrollmentWindowInput,
  BenefitPlansQuery,
} from "./dto/benefits.schemas";

type BenefitPlansCursorScope = {
  orgId: string;
  status: string | null;
  category: string | null;
};

function invalidBenefitPlansCursor(): never {
  throw new BadRequestException({
    code: "INVALID_BENEFIT_PLANS_CURSOR",
    message: "The benefit plans cursor is invalid or expired.",
  });
}

function decodeBenefitPlansCursor(
  value: string | undefined,
  expected: BenefitPlansCursorScope,
) {
  if (!value) return null;
  const position = decodeCursor(value);
  if (!position) return invalidBenefitPlansCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 4 ||
      typeof scope[0] !== "number" ||
      !Number.isSafeInteger(scope[0]) ||
      scope[0] < 1 ||
      scope[1] !== expected.orgId ||
      scope[2] !== expected.status ||
      scope[3] !== expected.category
    )
      return invalidBenefitPlansCursor();
    return { sortValue: position.sortValue, id: String(scope[0]) };
  } catch {
    return invalidBenefitPlansCursor();
  }
}

@Injectable()
export class HrBenefitsPlansService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPlans(orgId: string, query: BenefitPlansQuery) {
    const { cursor, status, category, limit } = query;
    const cursorScope = {
      orgId,
      status: status ?? null,
      category: category ?? null,
    };
    const position = decodeBenefitPlansCursor(cursor, cursorScope);

    const conditions = [eq(hrBenefitPlans.orgId, orgId)];
    if (status) conditions.push(eq(hrBenefitPlans.status, status));
    if (category) conditions.push(eq(hrBenefitPlans.category, category));
    if (position)
      conditions.push(keysetAfterValue(hrBenefitPlans.name, hrBenefitPlans.id, position));

    const rows = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(...conditions))
      .orderBy(asc(hrBenefitPlans.name), asc(hrBenefitPlans.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.name,
      id: JSON.stringify([
        row.id,
        cursorScope.orgId,
        cursorScope.status,
        cursorScope.category,
      ]),
    }));
  }

  async getPlan(orgId: string, planId: number) {
    const [plan] = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
      .limit(1);

    if (!plan) throw new NotFoundException("Benefit plan not found");
    return plan;
  }

  async createPlan(orgId: string, data: CreateBenefitPlanInput) {
    try {
      const [plan] = await this.db
        .insert(hrBenefitPlans)
        .values({ ...data, orgId })
        .returning();
      return plan;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A benefit plan with this name already exists");
      }
      throw err;
    }
  }

  async updatePlan(orgId: string, planId: number, data: PatchBenefitPlanInput) {
    try {
      const [updated] = await this.db
        .update(hrBenefitPlans)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Benefit plan not found");
      return updated;
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A benefit plan with this name already exists");
      }
      throw err;
    }
  }

  async deletePlan(orgId: string, planId: number) {
    const [deleted] = await this.db
      .delete(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Benefit plan not found");
    return { ok: true };
  }

  async listWindows(orgId: string) {
    return this.db
      .select()
      .from(hrBenefitEnrollmentWindows)
      .where(eq(hrBenefitEnrollmentWindows.orgId, orgId))
      .orderBy(desc(hrBenefitEnrollmentWindows.opensAt))
      .limit(50);
  }

  async createWindow(orgId: string, data: CreateEnrollmentWindowInput) {
    const [window] = await this.db
      .insert(hrBenefitEnrollmentWindows)
      .values({ ...data, opensAt: new Date(data.opensAt), closesAt: new Date(data.closesAt), orgId })
      .returning();
    return window;
  }

  async updateWindow(orgId: string, windowId: number, data: Partial<CreateEnrollmentWindowInput>) {
    const [existing] = await this.db
      .select()
      .from(hrBenefitEnrollmentWindows)
      .where(and(eq(hrBenefitEnrollmentWindows.id, windowId), eq(hrBenefitEnrollmentWindows.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Enrollment window not found");

    const { opensAt, closesAt, ...rest } = data;
    const [updated] = await this.db
      .update(hrBenefitEnrollmentWindows)
      .set({
        ...rest,
        ...(opensAt ? { opensAt: new Date(opensAt) } : {}),
        ...(closesAt ? { closesAt: new Date(closesAt) } : {}),
      })
      .where(and(eq(hrBenefitEnrollmentWindows.id, windowId), eq(hrBenefitEnrollmentWindows.orgId, orgId)))
      .returning();
    return updated;
  }

  /**
   * Enrollment windows are opt-in: a plan/org with none configured has no restriction (the
   * feature was never set up for it). Only enforced once at least one window row exists in
   * scope for this plan (plan-specific, or org-wide via a null planId).
   */
  async checkEnrollmentWindowOpen(orgId: string, planId: number): Promise<boolean> {
    const now = new Date();
    const [summary] = await this.db
      .select({
        configured: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${hrBenefitEnrollmentWindows.status} = 'open' and ${hrBenefitEnrollmentWindows.opensAt} <= ${now} and ${hrBenefitEnrollmentWindows.closesAt} >= ${now})::int`,
      })
      .from(hrBenefitEnrollmentWindows)
      .where(
        and(
          eq(hrBenefitEnrollmentWindows.orgId, orgId),
          or(eq(hrBenefitEnrollmentWindows.planId, planId), isNull(hrBenefitEnrollmentWindows.planId)),
        ),
      );

    if (!summary || summary.configured === 0) return true;
    return summary.open > 0;
  }
}
