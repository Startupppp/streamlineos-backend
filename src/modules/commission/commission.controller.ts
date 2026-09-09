import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { readRequestScope } from "../organization/core/read-request-scope";
import { CommissionService } from "./commission.service";
import {
  assignSchema,
  calculateForDealSchema,
  createPlanSchema,
  createVersionSchema,
  endAssignmentSchema,
  listEarningsQuerySchema,
  resolveVersionQuerySchema,
  updatePlanSchema,
  updateVersionSchema,
  type AssignInput,
  type CalculateForDealInput,
  type CreatePlanInput,
  type CreateVersionInput,
  type EndAssignmentInput,
  type ListEarningsQuery,
  type ResolveVersionQuery,
  type UpdatePlanInput,
  type UpdateVersionInput,
} from "./dto/commission.schemas";

/**
 * The commission surface, split along the only line that matters here: who may
 * change what a plan pays, and who may see what it paid.
 *
 * `crm:commission-plans:manage` is the authority to define money. It is
 * deliberately NOT the authority to approve a payout — `:approve` is separate so
 * that the person who wrote the rate cannot also sign off their own number, and
 * an organisation that wants those to be one person can grant both.
 *
 * `:calculate` is separate again, because computing an earning is a write that
 * seals a plan version permanently. It looks like a read and is not one.
 *
 * There is no route that edits a sealed version and none that recalculates a
 * period in bulk. Both are absent on purpose; see the service docblock.
 */
@RequireModule("crm")
@Controller("crm/commission")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CommissionController {
  constructor(private readonly service: CommissionService) {}

  // ── Plans ────────────────────────────────────────────────────────────────

  @Get("plans")
  @RequirePermission("crm:commission-plans:view")
  listPlans(@CurrentUser() u: CurrentUserContext) {
    return this.service.listPlans(u.orgId);
  }

  @Post("plans")
  @HttpCode(201)
  @RequirePermission("crm:commission-plans:manage")
  @Idempotent("crm.commission.plan.create")
  createPlan(
    @Body(new ZodValidationPipe(createPlanSchema)) body: CreatePlanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createPlan(u.orgId, u.userId, body);
  }

  @Get("plans/:planId")
  @RequirePermission("crm:commission-plans:view")
  getPlan(@Param("planId") planId: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.getPlan(u.orgId, planId);
  }

  @Patch("plans/:planId")
  @RequirePermission("crm:commission-plans:manage")
  updatePlan(
    @Param("planId") planId: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) body: UpdatePlanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updatePlan(u.orgId, planId, body);
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  /**
   * What the plan paid on a given date, resolved rather than assumed.
   *
   * A read route rather than a report field, because the question "which rules
   * applied on the day this deal closed?" is the one every commission dispute
   * opens with, and answering it should not require anyone to reason about the
   * version list themselves.
   */
  @Get("plans/:planId/version-in-force")
  @RequirePermission("crm:commission-plans:view")
  versionInForce(
    @Param("planId") planId: string,
    @Query(new ZodValidationPipe(resolveVersionQuerySchema)) query: ResolveVersionQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.resolveVersion(u.orgId, planId, query.on);
  }

  @Post("plans/:planId/versions")
  @HttpCode(201)
  @RequirePermission("crm:commission-plans:manage")
  @Idempotent("crm.commission.version.create")
  createVersion(
    @Param("planId") planId: string,
    @Body(new ZodValidationPipe(createVersionSchema)) body: CreateVersionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createVersion(u.orgId, planId, u.userId, body);
  }

  /** 409s once the version has been earned against. That is the feature. */
  @Patch("plans/:planId/versions/:planVersionId")
  @RequirePermission("crm:commission-plans:manage")
  updateVersion(
    @Param("planId") planId: string,
    @Param("planVersionId") planVersionId: string,
    @Body(new ZodValidationPipe(updateVersionSchema)) body: UpdateVersionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateVersion(u.orgId, planId, planVersionId, body);
  }

  // ── Assignments ──────────────────────────────────────────────────────────

  @Post("plans/:planId/assignments")
  @HttpCode(201)
  @RequirePermission("crm:commission-plans:manage")
  assign(
    @Param("planId") planId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.assign(u.orgId, planId, body);
  }

  @Patch("assignments/:assignmentId/end")
  @RequirePermission("crm:commission-plans:manage")
  endAssignment(
    @Param("assignmentId") assignmentId: string,
    @Body(new ZodValidationPipe(endAssignmentSchema)) body: EndAssignmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.endAssignment(u.orgId, assignmentId, body);
  }

  // ── Earnings ─────────────────────────────────────────────────────────────

  /**
   * Idempotent by unique index as well as by header.
   *
   * `@Idempotent` covers a retry that carries the same key; the unique index on
   * (org, source, user) covers the retry that does not — a second request from
   * a different client, or a replay after the interceptor's record expired.
   * Paying a rep twice for one deal is not a failure anybody notices quickly.
   */
  @Post("earnings/calculate")
  @HttpCode(201)
  @RequirePermission("crm:commission-earnings:calculate")
  @Idempotent("crm.commission.earning.calculate")
  calculate(
    @Body(new ZodValidationPipe(calculateForDealSchema)) body: CalculateForDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.calculateForDeal(u.orgId, body);
  }

  @Get("earnings")
  @RequirePermission("crm:commission-earnings:view")
  listEarnings(
    @Query(new ZodValidationPipe(listEarningsQuerySchema)) query: ListEarningsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    // Fail-closed: `readRequestScope` answers "none" when the guard did not run,
    // so a mis-wired route narrows to the caller rather than opening the ledger.
    return this.service.listEarnings(u.orgId, query, {
      userId: u.userId,
      viewAll: readRequestScope(req) === "all",
    });
  }

  @Post("earnings/:earningId/approve")
  @HttpCode(200)
  @RequirePermission("crm:commission-earnings:approve")
  /**
   * Fenced, because this one settles money owed to a person. A retried
   * approval — a double-tap, a proxy replay, a client that resends on a
   * timeout it never saw resolve — must return the first approval rather than
   * record a second, and the retry is exactly the case where nobody is
   * watching closely enough to notice.
   */
  @Idempotent("crm.commission.earning_approve")
  approve(
    @Param("earningId") earningId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approveEarning(u.orgId, earningId, u.userId);
  }
}
