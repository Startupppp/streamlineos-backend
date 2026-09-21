import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import { users, wfhRequests } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { formatDateOnly } from "../../../common/date";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateWfhInput, UpdateWfhInput } from "./dto/wfh.schemas";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { AccessService } from "../../access/access.service";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import { requireOrganizationMembershipId } from "./organization-membership";
import { attendanceMemberScope, resolveAttendanceScope } from "./attendance-scope";

@Injectable()
export class WfhService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly approvals: ApprovalAuthorityService,
    @Optional() private readonly policyEval: HrPolicyEvaluationService,
  ) {}

  async list(orgId: string, userId: string) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    return this.db.query.wfhRequests.findMany({
      where: and(eq(wfhRequests.orgId, orgId), eq(wfhRequests.userMembershipId, userMembershipId)),
      orderBy: [desc(wfhRequests.createdAt)],
      limit: 100,
    });
  }

  async create(orgId: string, userId: string, body: CreateWfhInput) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
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
          eq(wfhRequests.userMembershipId, userMembershipId),
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

    const route = await this.approvals.resolve(orgId, userId, "wfh");
    if (route.rung === null)
      throw new ConflictException(`${route.explanation} Ask an HR administrator to assign a reporting manager or grant attendance management.`);

    await this.db
      .insert(wfhRequests)
      .values({
        orgId,
        userId,
        userMembershipId,
        date: formatDateOnly(body.date),
        reason: body.reason,
        approverId: route.approver?.userId ?? null,
        approverMembershipId: route.approver?.membershipId ?? null,
        status: "PENDING",
      })
      .returning();

    return { success: true };
  }

  async pendingRoutedTo(orgId: string, approverMembershipId: number, limit: number) {
    return this.db
      .select({
        id: wfhRequests.id,
        userId: wfhRequests.userId,
        date: wfhRequests.date,
        reason: wfhRequests.reason,
        createdAt: wfhRequests.createdAt,
        userName: users.name,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
      })
      .from(wfhRequests)
      .innerJoin(users, eq(wfhRequests.userId, users.id))
      .where(
        and(
          eq(wfhRequests.orgId, orgId),
          eq(wfhRequests.status, "PENDING"),
          eq(wfhRequests.approverMembershipId, approverMembershipId),
        ),
      )
      .orderBy(asc(wfhRequests.createdAt))
      .limit(Math.min(limit, 100));
  }

  async pending(currentUser: CurrentUserContext) {
    const orgId = currentUser.orgId;
    const scope = await resolveAttendanceScope(this.access, currentUser);
    const actorMembershipId = await requireOrganizationMembershipId(this.db, orgId, currentUser.userId);
    const rows = await scope.read(
      {
        tenant: wfhRequests.orgId,
        scope: attendanceMemberScope(actorMembershipId, wfhRequests.approverMembershipId),
        and: [eq(wfhRequests.status, "PENDING")],
      },
      ({ sql: where }) => this.db
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
      .where(where)
      .orderBy(desc(wfhRequests.createdAt))
      .limit(100),
      () => [],
    );

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

  async update(currentUser: CurrentUserContext, requestId: number, body: UpdateWfhInput) {
    const orgId = currentUser.orgId;
    const scope = await resolveAttendanceScope(this.access, currentUser);
    const approverMembershipId = await requireOrganizationMembershipId(this.db, orgId, currentUser.userId);
    const existing = await scope.read(
      {
        tenant: wfhRequests.orgId,
        scope: attendanceMemberScope(approverMembershipId, wfhRequests.approverMembershipId),
        and: [eq(wfhRequests.id, requestId)],
      },
      ({ sql: where }) =>
        this.db
          .select({ id: wfhRequests.id, userMembershipId: wfhRequests.userMembershipId })
          .from(wfhRequests)
          .where(where)
          .limit(1),
      () => [],
    );

    if (!existing[0]) throw new NotFoundException("WFH request not found.");
    if (existing[0].userMembershipId === approverMembershipId)
      throw new BadRequestException("You cannot decide your own work-from-home request.");

    await this.db
      .update(wfhRequests)
      .set({
        status: body.status,
        rejectionReason: body.status === "REJECTED" ? (body.rejectionReason ?? null) : null,
        approverId: currentUser.userId,
        approverMembershipId,
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
