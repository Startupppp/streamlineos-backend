import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrBenefitsPlansService } from "./hr-benefits-plans.service";
import { HrBenefitsEnrollmentService } from "./hr-benefits-enrollment.service";
import { HrBenefitsClaimsService } from "./hr-benefits-claims.service";
import {
  createBenefitPlanSchema,
  patchBenefitPlanSchema,
  createEnrollmentWindowSchema,
  enrollSchema,
  waiveSchema,
  createDependentSchema,
  patchDependentSchema,
  submitClaimSchema,
  reviewClaimSchema,
  setPayoutRouteSchema,
  benefitPlansQuerySchema,
  claimsQuerySchema,
  type CreateBenefitPlanInput,
  type PatchBenefitPlanInput,
  type CreateEnrollmentWindowInput,
  type EnrollInput,
  type WaiveInput,
  type CreateDependentInput,
  type PatchDependentInput,
  type SubmitClaimInput,
  type ReviewClaimInput,
  type SetPayoutRouteInput,
  type BenefitPlansQuery,
  type ClaimsQuery,
} from "./dto/benefits.schemas";
import { AccessService } from "../../access/access.service";

@RequireModule("hr")
@Controller("hr/benefits")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrBenefitsController {
  constructor(
    private readonly plans: HrBenefitsPlansService,
    private readonly enrollment: HrBenefitsEnrollmentService,
    private readonly claims: HrBenefitsClaimsService,
    private readonly access: AccessService,
  ) {}

  private async isAdmin(u: CurrentUserContext) {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:benefits:manage");
  }

  @Get("plans/available")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  listActivePlans(@CurrentUser() u: CurrentUserContext) {
    return this.plans.listPlans(u.orgId, { status: "active", page: 1, limit: 100 });
  }

  @Get("plans")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  listPlans(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(benefitPlansQuerySchema)) query: BenefitPlansQuery,
  ) {
    return this.plans.listPlans(u.orgId, query);
  }

  @Get("plans/:planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  getPlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
  ) {
    return this.plans.getPlan(u.orgId, planId);
  }

  @Get("plans/:planId/eligibility")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  checkEligibility(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
    @Query("employeeId") employeeId: string,
  ) {
    const targetId = employeeId ?? u.userId;
    return this.enrollment.checkEligibility(u.orgId, planId, targetId);
  }

  @Post("plans")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  createPlan(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createBenefitPlanSchema)) body: CreateBenefitPlanInput,
  ) {
    return this.plans.createPlan(u.orgId, body);
  }

  @Patch("plans/:planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  updatePlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
    @Body(new ZodValidationPipe(patchBenefitPlanSchema)) body: PatchBenefitPlanInput,
  ) {
    return this.plans.updatePlan(u.orgId, planId, body);
  }

  @Delete("plans/:planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  deletePlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
  ) {
    return this.plans.deletePlan(u.orgId, planId);
  }

  @Get("windows")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  listWindows(@CurrentUser() u: CurrentUserContext) {
    return this.plans.listWindows(u.orgId);
  }

  @Post("windows")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  createWindow(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createEnrollmentWindowSchema)) body: CreateEnrollmentWindowInput,
  ) {
    return this.plans.createWindow(u.orgId, body);
  }

  @Patch("windows/:windowId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  updateWindow(
    @CurrentUser() u: CurrentUserContext,
    @Param("windowId", ParseIntPipe) windowId: number,
    @Body(new ZodValidationPipe(createEnrollmentWindowSchema.partial())) body: Partial<CreateEnrollmentWindowInput>,
  ) {
    return this.plans.updateWindow(u.orgId, windowId, body);
  }

  @Get("my")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  getMyBenefits(@CurrentUser() u: CurrentUserContext) {
    return this.enrollment.getMyBenefits(u.orgId, u.userId);
  }

  @Post("enroll")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  enroll(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(enrollSchema)) body: EnrollInput,
  ) {
    return this.enrollment.enroll(u.orgId, u.userId, body);
  }

  @Post("waive")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  waive(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(waiveSchema)) body: WaiveInput,
  ) {
    return this.enrollment.waive(u.orgId, u.userId, body);
  }

  @Get("dependents")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  listDependents(@CurrentUser() u: CurrentUserContext) {
    return this.enrollment.listDependents(u.orgId, u.userId);
  }

  @Post("dependents")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  addDependent(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createDependentSchema)) body: CreateDependentInput,
  ) {
    return this.enrollment.addDependent(u.orgId, u.userId, body);
  }

  @Patch("dependents/:depId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  updateDependent(
    @CurrentUser() u: CurrentUserContext,
    @Param("depId", ParseIntPipe) depId: number,
    @Body(new ZodValidationPipe(patchDependentSchema)) body: PatchDependentInput,
  ) {
    return this.enrollment.updateDependent(u.orgId, u.userId, depId, body);
  }

  @Delete("dependents/:depId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  deleteDependent(
    @CurrentUser() u: CurrentUserContext,
    @Param("depId", ParseIntPipe) depId: number,
  ) {
    return this.enrollment.deleteDependent(u.orgId, u.userId, depId);
  }

  @Get("claims")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  async listClaims(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(claimsQuerySchema)) query: ClaimsQuery,
  ) {
    const isAdmin = await this.isAdmin(u);
    return this.claims.listClaims(u.orgId, query, u.userId, isAdmin);
  }

  @Post("claims")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  submitClaim(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(submitClaimSchema)) body: SubmitClaimInput,
  ) {
    return this.claims.submitClaim(u.orgId, u.userId, body);
  }

  @Patch("claims/:claimId/review")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  reviewClaim(
    @CurrentUser() u: CurrentUserContext,
    @Param("claimId", ParseIntPipe) claimId: number,
    @Body(new ZodValidationPipe(reviewClaimSchema)) body: ReviewClaimInput,
  ) {
    return this.claims.reviewClaim(u.orgId, claimId, u.userId, body);
  }

  @Patch("claims/:claimId/payout-route")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  setPayoutRoute(
    @CurrentUser() u: CurrentUserContext,
    @Param("claimId", ParseIntPipe) claimId: number,
    @Body(new ZodValidationPipe(setPayoutRouteSchema)) body: SetPayoutRouteInput,
  ) {
    return this.claims.setPayoutRoute(u.orgId, claimId, body.payoutRoute);
  }
}
