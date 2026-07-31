import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { users, wfhRequests } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { formatDateOnly } from "../../../common/date";
import type { CreateWfhInput, UpdateWfhInput } from "./dto/wfh.schemas";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";

@Injectable()
export class WfhService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly policyEval: HrPolicyEvaluationService,
  ) {}

  list(orgId: string, userId: string) {
    return this.db.query.wfhRequests.findMany({
      where: and(eq(wfhRequests.orgId, orgId), eq(wfhRequests.userId, userId)),
      orderBy: [desc(wfhRequests.createdAt)],
      limit: 100,
    });
  }

  async create(orgId: string, userId: string, body: CreateWfhInput) {
    const quota = await this.resolveMonthlyQuota(orgId, userId);

    const requestDate = new Date(body.date);
    const monthStart = formatDateOnly(new Date(requestDate.getFullYear(), requestDate.getMonth(), 1));
    const monthEnd = formatDateOnly(new Date(requestDate.getFullYear(), requestDate.getMonth() + 1, 0));

    const [used] = await this.db
      .select({ total: count(wfhRequests.id) })
      .from(wfhRequests)
      .where(
        and(
          eq(wfhRequests.orgId, orgId),
          eq(wfhRequests.userId, userId),
          gte(wfhRequests.date, monthStart),
          lte(wfhRequests.date, monthEnd),
          eq(wfhRequests.status, "APPROVED"),
        ),
      );

    const usedCount = Number(used?.total ?? 0);
    if (quota !== null && usedCount >= quota) {
      throw new BadRequestException(
        `Monthly WFH quota of ${quota} days has been reached for this month.`,
      );
    }

    await this.db
      .insert(wfhRequests)
      .values({
        orgId,
        userId,
        date: formatDateOnly(body.date),
        reason: body.reason,
        approverId: body.approverId,
        status: "PENDING",
      })
      .returning();

    return { success: true };
  }

  async pending(orgId: string) {
    const rows = await this.db
      .select({
        id: wfhRequests.id,
        orgId: wfhRequests.orgId,
        userId: wfhRequests.userId,
        date: wfhRequests.date,
        reason: wfhRequests.reason,
        status: wfhRequests.status,
        approverId: wfhRequests.approverId,
        rejectionReason: wfhRequests.rejectionReason,
        createdAt: wfhRequests.createdAt,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(wfhRequests)
      .innerJoin(users, eq(wfhRequests.userId, users.id))
      .where(and(eq(wfhRequests.orgId, orgId), eq(wfhRequests.status, "PENDING")))
      .orderBy(desc(wfhRequests.createdAt))
      .limit(100);

    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      userId: r.userId,
      date: r.date,
      reason: r.reason,
      status: r.status,
      approverId: r.approverId,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt,
      user: {
        id: r.userId,
        firstName: r.userFirstName,
        lastName: r.userLastName,
        email: r.userEmail,
        image: r.userImage,
      },
    }));
  }

  async update(orgId: string, approverId: string, requestId: number, body: UpdateWfhInput) {
    const existing = await this.db.query.wfhRequests.findFirst({
      where: and(eq(wfhRequests.id, requestId), eq(wfhRequests.orgId, orgId)),
    });

    if (!existing) throw new NotFoundException("WFH request not found.");

    await this.db
      .update(wfhRequests)
      .set({
        status: body.status,
        rejectionReason: body.status === "REJECTED" ? (body.rejectionReason ?? null) : null,
        approverId,
      })
      .where(and(eq(wfhRequests.id, requestId), eq(wfhRequests.orgId, orgId)));

    return { success: true };
  }

  private async resolveMonthlyQuota(orgId: string, userId: string): Promise<number | null> {
    if (!this.policyEval) return null;
    const result = await this.policyEval.evaluatePolicy(
      orgId,
      userId,
      "wfh",
      new Date().toISOString().slice(0, 10),
    );
    if (!result) return null;
    const rules = result.rules as Record<string, unknown>;
    return typeof rules["monthlyQuota"] === "number" ? rules["monthlyQuota"] : null;
  }
}
