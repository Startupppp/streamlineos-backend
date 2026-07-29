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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import {
  createHeadcountSchema,
  createReferralSubmissionSchema,
  createSubmissionSchema,
  createVendorSchema,
  headcountListSchema,
  rejectHeadcountSchema,
  submissionIdQuerySchema,
  updateExternalReferralSchema,
  updateExternalReferrerStatusSchema,
  updateHeadcountSchema,
  updateReferralStatusSchema,
  updateSubmissionSchema,
  updateVendorSchema,
  type CreateHeadcountInput,
  type CreateReferralSubmissionInput,
  type CreateSubmissionInput,
  type CreateVendorInput,
  type HeadcountListInput,
  type RejectHeadcountInput,
  type SubmissionIdQueryInput,
  type UpdateExternalReferralInput,
  type UpdateExternalReferrerStatusInput,
  type UpdateHeadcountInput,
  type UpdateReferralStatusInput,
  type UpdateSubmissionInput,
  type UpdateVendorInput,
} from "./dto/sourcing.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentSourcingController {
  constructor(
    private readonly sourcing: RecruitmentSourcingService,
    private readonly access: AccessService,
  ) {}

  @Get("referrals")
  @RequirePermission("hr:employees:view")
  async listReferrals(@CurrentUser() u: CurrentUserContext) {
    const canManage = u.isOrgOwner || u.isPlatformAdmin
      || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listReferrals(u.orgId, u.userId, canManage);
  }

  @Post("referrals")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  createReferral(
    @Body(new ZodValidationPipe(createReferralSubmissionSchema)) body: CreateReferralSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createReferral(u.orgId, u.userId, body);
  }

  @Patch("referrals/:referralId")
  @RequirePermission("hr:employees:manage")
  updateReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body(new ZodValidationPipe(updateReferralStatusSchema)) body: UpdateReferralStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateReferralStatus(u.orgId, referralId, body);
  }

  @Get("vendors")
  @RequirePermission("hr:employees:view")
  listVendors(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listVendors(u.orgId);
  }

  @Post("vendors")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  createVendor(@Body(new ZodValidationPipe(createVendorSchema)) body: CreateVendorInput, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.createVendor(u.orgId, u.userId, body);
  }

  @Patch("vendors/:vendorId")
  @RequirePermission("hr:employees:manage")
  updateVendor(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body(new ZodValidationPipe(updateVendorSchema)) body: UpdateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateVendor(u.orgId, vendorId, body);
  }

  @Delete("vendors/:vendorId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  async deleteVendor(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    await this.sourcing.deleteVendor(u.orgId, vendorId);
  }

  @Post("vendors/:vendorId/portal-link")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  generateVendorPortalLink(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.generateVendorPortalLink(u.orgId, vendorId);
  }

  @Get("vendors/:vendorId/submissions")
  @RequirePermission("hr:employees:view")
  async listSubmissions(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    const canViewFinancials =
      u.isOrgOwner || u.isPlatformAdmin || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:employees:manage");
    return this.sourcing.listSubmissions(u.orgId, vendorId, canViewFinancials);
  }

  @Post("vendors/:vendorId/submissions")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  createSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body(new ZodValidationPipe(createSubmissionSchema)) body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createSubmission(u.orgId, vendorId, body);
  }

  @Patch("vendors/:vendorId/submissions")
  @RequirePermission("hr:employees:manage")
  updateSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query(new ZodValidationPipe(submissionIdQuerySchema)) query: SubmissionIdQueryInput,
    @Body(new ZodValidationPipe(updateSubmissionSchema)) body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateSubmission(u.orgId, vendorId, query.submissionId, body);
  }

  @Get("headcount")
  @RequirePermission("hr:employees:view")
  async listHeadcount(
    @Query(new ZodValidationPipe(headcountListSchema)) query: HeadcountListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canManage = u.isOrgOwner || u.isPlatformAdmin
      || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listHeadcount(u.orgId, u.userId, canManage, query);
  }

  @Post("headcount")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  createHeadcount(
    @Body(new ZodValidationPipe(createHeadcountSchema)) body: CreateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createHeadcount(u.orgId, u.userId, body);
  }

  @Patch("headcount/:requestId")
  @RequirePermission("hr:employees:view")
  updateHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(updateHeadcountSchema)) body: UpdateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateHeadcount(u.orgId, u.userId, requestId, body);
  }

  @Post("headcount/:requestId/approve")
  @RequirePermission("hr:employees:manage")
  approveHeadcount(@Param("requestId", ParseIntPipe) requestId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.approveHeadcount(u.orgId, u.userId, requestId);
  }

  @Post("headcount/:requestId/reject")
  @RequirePermission("hr:employees:manage")
  rejectHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(rejectHeadcountSchema)) body: RejectHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.rejectHeadcount(u.orgId, requestId, body.reason);
  }

  @Post("headcount/:requestId/create-job")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  createJobFromHeadcount(@Param("requestId", ParseIntPipe) requestId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.createJobFromHeadcount(u.orgId, u.userId, requestId);
  }

  @Get("external-referrals")
  @RequirePermission("hr:employees:view")
  listExternalReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listExternalReferrals(u.orgId);
  }

  @Patch("external-referrals/:referralId")
  @RequirePermission("hr:employees:manage")
  updateExternalReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body(new ZodValidationPipe(updateExternalReferralSchema)) body: UpdateExternalReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateExternalReferral(u.orgId, referralId, body);
  }

  @Get("external-referrers")
  @RequirePermission("hr:employees:view")
  listExternalReferrers(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listExternalReferrers(u.orgId);
  }

  @Patch("external-referrers/:referrerId")
  @RequirePermission("hr:employees:manage")
  updateExternalReferrerStatus(
    @Param("referrerId", ParseIntPipe) referrerId: number,
    @Body(new ZodValidationPipe(updateExternalReferrerStatusSchema)) body: UpdateExternalReferrerStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateExternalReferrerStatus(u.orgId, referrerId, body);
  }
}
