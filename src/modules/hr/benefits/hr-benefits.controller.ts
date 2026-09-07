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
import { actingMembershipId } from "../../../common/auth/principal";
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
  availableBenefitPlansQuerySchema,
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
  type AvailableBenefitPlansQuery,
  type ClaimsQuery,
} from "./dto/benefits.schemas";
import { AccessService } from "../../access/access.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listPlansResponseSchema, getPlanResponseSchema, checkEligibilityResponseSchema, createPlanResponseSchema, updatePlanResponseSchema, deletePlanResponseSchema, listWindowsResponseSchema, createWindowResponseSchema, updateWindowResponseSchema, getMyBenefitsResponseSchema, enrollResponseSchema, waiveResponseSchema, listDependentsResponseSchema, addDependentResponseSchema, updateDependentResponseSchema, deleteDependentResponseSchema, listClaimsResponseSchema, submitClaimResponseSchema, reviewClaimResponseSchema, setPayoutRouteResponseSchema } from "./dto/benefits-response.schemas"

const planIdParams = z.object({ planId: z.coerce.number().int().positive() }).strict();
const windowIdParams = z.object({ windowId: z.coerce.number().int().positive() }).strict();
const depIdParams = z.object({ depId: z.coerce.number().int().positive() }).strict();
const claimIdParams = z.object({ claimId: z.coerce.number().int().positive() }).strict();
const updateWindowSchema = createEnrollmentWindowSchema.partial();

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

  @ResponseSchema(listPlansResponseSchema)
  @Get("plans/available")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ query: availableBenefitPlansQuerySchema })
  listActivePlans(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: AvailableBenefitPlansQuery,
  ) {
    return this.plans.listPlans(u.orgId, { ...query, status: "active" });
  }

  @ResponseSchema(listPlansResponseSchema)
  @Get("plans")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ query: benefitPlansQuerySchema })
  listPlans(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: BenefitPlansQuery,
  ) {
    return this.plans.listPlans(u.orgId, query);
  }

  @ResponseSchema(getPlanResponseSchema)
  @Get("plans/:planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ params: planIdParams })
  getPlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
  ) {
    return this.plans.getPlan(u.orgId, planId);
  }

  @ResponseSchema(checkEligibilityResponseSchema)
  @Get("plans/:planId/eligibility")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ params: planIdParams })
  async checkEligibility(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
    @Query("employeeId") employeeId: string | undefined,
  ) {
    const admin = await this.isAdmin(u);
    const targetId = admin && employeeId ? employeeId : u.userId;
    return this.enrollment.checkEligibility(u.orgId, planId, targetId);
  }

  @ResponseSchema(createPlanResponseSchema)
  @Post("plans")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ body: createBenefitPlanSchema })
  createPlan(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateBenefitPlanInput,
  ) {
    return this.plans.createPlan(u.orgId, body);
  }

  @ResponseSchema(updatePlanResponseSchema)
  @Patch("plans/:planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: planIdParams, body: patchBenefitPlanSchema })
  updatePlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
    @Body() body: PatchBenefitPlanInput,
  ) {
    return this.plans.updatePlan(u.orgId, planId, body);
  }

  @ResponseSchema(deletePlanResponseSchema)
  @Delete("plans/:planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: planIdParams })
  deletePlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
  ) {
    return this.plans.deletePlan(u.orgId, planId);
  }

  @ResponseSchema(listWindowsResponseSchema)
  @Get("windows")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  listWindows(@CurrentUser() u: CurrentUserContext) {
    return this.plans.listWindows(u.orgId);
  }

  @ResponseSchema(createWindowResponseSchema)
  @Post("windows")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ body: createEnrollmentWindowSchema })
  createWindow(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateEnrollmentWindowInput,
  ) {
    return this.plans.createWindow(u.orgId, body);
  }

  @ResponseSchema(updateWindowResponseSchema)
  @Patch("windows/:windowId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: windowIdParams, body: updateWindowSchema })
  updateWindow(
    @CurrentUser() u: CurrentUserContext,
    @Param("windowId", ParseIntPipe) windowId: number,
    @Body() body: Partial<CreateEnrollmentWindowInput>,
  ) {
    return this.plans.updateWindow(u.orgId, windowId, body);
  }

  @ResponseSchema(getMyBenefitsResponseSchema)
  @Get("my")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  getMyBenefits(@CurrentUser() u: CurrentUserContext) {
    return this.enrollment.getMyBenefits(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @ResponseSchema(enrollResponseSchema)
  @Post("enroll")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ body: enrollSchema })
  enroll(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EnrollInput,
  ) {
    return this.enrollment.enroll(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(waiveResponseSchema)
  @Post("waive")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ body: waiveSchema })
  waive(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: WaiveInput,
  ) {
    return this.enrollment.waive(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(listDependentsResponseSchema)
  @Get("dependents")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  listDependents(@CurrentUser() u: CurrentUserContext) {
    return this.enrollment.listDependents(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @ResponseSchema(addDependentResponseSchema)
  @Post("dependents")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ body: createDependentSchema })
  addDependent(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateDependentInput,
  ) {
    return this.enrollment.addDependent(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(updateDependentResponseSchema)
  @Patch("dependents/:depId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ params: depIdParams, body: patchDependentSchema })
  updateDependent(
    @CurrentUser() u: CurrentUserContext,
    @Param("depId", ParseIntPipe) depId: number,
    @Body() body: PatchDependentInput,
  ) {
    return this.enrollment.updateDependent(u.orgId, u.userId, actingMembershipId(u.principal), depId, body);
  }

  @ResponseSchema(deleteDependentResponseSchema)
  @Delete("dependents/:depId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ params: depIdParams })
  deleteDependent(
    @CurrentUser() u: CurrentUserContext,
    @Param("depId", ParseIntPipe) depId: number,
  ) {
    return this.enrollment.deleteDependent(u.orgId, u.userId, actingMembershipId(u.principal), depId);
  }

  @ResponseSchema(listClaimsResponseSchema)
  @Get("claims")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ query: claimsQuerySchema })
  async listClaims(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ClaimsQuery,
  ) {
    const isAdmin = await this.isAdmin(u);
    return this.claims.listClaims(u.orgId, query, u.userId, actingMembershipId(u.principal), isAdmin);
  }

  @ResponseSchema(submitClaimResponseSchema)
  @Post("claims")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ body: submitClaimSchema })
  submitClaim(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: SubmitClaimInput,
  ) {
    return this.claims.submitClaim(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(reviewClaimResponseSchema)
  @Patch("claims/:claimId/review")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: claimIdParams, body: reviewClaimSchema })
  reviewClaim(
    @CurrentUser() u: CurrentUserContext,
    @Param("claimId", ParseIntPipe) claimId: number,
    @Body() body: ReviewClaimInput,
  ) {
    return this.claims.reviewClaim(u.orgId, claimId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(setPayoutRouteResponseSchema)
  @Patch("claims/:claimId/payout-route")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: claimIdParams, body: setPayoutRouteSchema })
  setPayoutRoute(
    @CurrentUser() u: CurrentUserContext,
    @Param("claimId", ParseIntPipe) claimId: number,
    @Body() body: SetPayoutRouteInput,
  ) {
    return this.claims.setPayoutRoute(u.orgId, claimId, body.payoutRoute);
  }
}
