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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const referralIdParams = z.object({ referralId: z.coerce.number().int().positive() }).strict();
const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();
const requestIdParams = z.object({ requestId: z.coerce.number().int().positive() }).strict();
const referrerIdParams = z.object({ referrerId: z.coerce.number().int().positive() }).strict();

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
    const canManage = u.isOrgOwner
      || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listReferrals(u.orgId, u.userId, canManage);
  }

  @Post("referrals")
  @Idempotent("hr.sourcing.referral-create")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  @Validate({ body: createReferralSubmissionSchema })
  createReferral(
    @Body() body: CreateReferralSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createReferral(u.orgId, u.userId, body);
  }

  @Patch("referrals/:referralId")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: referralIdParams, body: updateReferralStatusSchema })
  updateReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body() body: UpdateReferralStatusInput,
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
  @Validate({ body: createVendorSchema })
  createVendor(@Body() body: CreateVendorInput, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.createVendor(u.orgId, u.userId, body);
  }

  @Patch("vendors/:vendorId")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: vendorIdParams, body: updateVendorSchema })
  updateVendor(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body() body: UpdateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateVendor(u.orgId, vendorId, body);
  }

  @Delete("vendors/:vendorId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: vendorIdParams })
  async deleteVendor(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    await this.sourcing.deleteVendor(u.orgId, vendorId);
  }

  @Post("vendors/:vendorId/portal-link")
  @BodylessAction()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: vendorIdParams })
  generateVendorPortalLink(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.generateVendorPortalLink(u.orgId, vendorId);
  }

  @Get("vendors/:vendorId/submissions")
  @RequirePermission("hr:employees:view")
  @Validate({ params: vendorIdParams })
  async listSubmissions(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    const canViewFinancials =
      u.isOrgOwner || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:employees:manage");
    return this.sourcing.listSubmissions(u.orgId, vendorId, canViewFinancials);
  }

  @Post("vendors/:vendorId/submissions")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: vendorIdParams, body: createSubmissionSchema })
  createSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body() body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createSubmission(u.orgId, vendorId, body);
  }

  @Patch("vendors/:vendorId/submissions")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: vendorIdParams, query: submissionIdQuerySchema, body: updateSubmissionSchema })
  updateSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query() query: SubmissionIdQueryInput,
    @Body() body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateSubmission(u.orgId, vendorId, query.submissionId, body);
  }

  @Get("headcount")
  @RequirePermission("hr:employees:view")
  @Validate({ query: headcountListSchema })
  async listHeadcount(
    @Query() query: HeadcountListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canManage = u.isOrgOwner
      || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listHeadcount(u.orgId, u.userId, canManage, query);
  }

  @Post("headcount")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  @Validate({ body: createHeadcountSchema })
  createHeadcount(
    @Body() body: CreateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createHeadcount(u.orgId, u.userId, body);
  }

  @Patch("headcount/:requestId")
  @RequirePermission("hr:employees:view")
  @Validate({ params: requestIdParams, body: updateHeadcountSchema })
  updateHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: UpdateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateHeadcount(u.orgId, u.userId, requestId, body);
  }

  @Post("headcount/:requestId/approve")
  @BodylessAction()
  @Idempotent("hr.headcount.approve")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: requestIdParams })
  approveHeadcount(@Param("requestId", ParseIntPipe) requestId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.approveHeadcount(u.orgId, u.userId, requestId);
  }

  @Post("headcount/:requestId/reject")
  @Idempotent("hr.headcount.reject")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: requestIdParams, body: rejectHeadcountSchema })
  rejectHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: RejectHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.rejectHeadcount(u.orgId, requestId, body.reason);
  }

  @Post("headcount/:requestId/create-job")
  @BodylessAction()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: requestIdParams })
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
  @Validate({ params: referralIdParams, body: updateExternalReferralSchema })
  updateExternalReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body() body: UpdateExternalReferralInput,
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
  @Validate({ params: referrerIdParams, body: updateExternalReferrerStatusSchema })
  updateExternalReferrerStatus(
    @Param("referrerId", ParseIntPipe) referrerId: number,
    @Body() body: UpdateExternalReferrerStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateExternalReferrerStatus(u.orgId, referrerId, body);
  }
}
