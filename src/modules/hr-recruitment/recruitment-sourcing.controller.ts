import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import { AccessService } from "../access/access.service";
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
@UseGuards(JwtAuthGuard)
export class RecruitmentSourcingController {
  constructor(
    private readonly sourcing: RecruitmentSourcingService,
    private readonly access: AccessService,
  ) {}

  @Get("referrals")
  listReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listReferrals(u.orgId, u.userId, u.role);
  }

  @Post("referrals")
  @HttpCode(201)
  createReferral(
    @Body(new ZodValidationPipe(createReferralSubmissionSchema)) body: CreateReferralSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createReferral(u.orgId, u.userId, body);
  }

  @Patch("referrals/:referralId")
  async updateReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body(new ZodValidationPipe(updateReferralStatusSchema)) body: UpdateReferralStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.updateReferralStatus(u.orgId, referralId, body);
  }

  @Get("vendors")
  listVendors(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listVendors(u.orgId);
  }

  @Post("vendors")
  @HttpCode(201)
  async createVendor(
    @Body(new ZodValidationPipe(createVendorSchema)) body: CreateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.createVendor(u.orgId, u.userId, body);
  }

  @Patch("vendors/:vendorId")
  async updateVendor(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body(new ZodValidationPipe(updateVendorSchema)) body: UpdateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.updateVendor(u.orgId, vendorId, body);
  }

  @Delete("vendors/:vendorId")
  async deleteVendor(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.deleteVendor(u.orgId, vendorId);
  }

  @Post("vendors/:vendorId/portal-link")
  @HttpCode(201)
  async generateVendorPortalLink(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.generateVendorPortalLink(u.orgId, vendorId);
  }

  @Get("vendors/:vendorId/submissions")
  async listSubmissions(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canViewFinancials =
      u.isOrgOwner || u.isPlatformAdmin || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:employees:manage");
    return this.sourcing.listSubmissions(u.orgId, vendorId, canViewFinancials);
  }

  @Post("vendors/:vendorId/submissions")
  @HttpCode(201)
  async createSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body(new ZodValidationPipe(createSubmissionSchema)) body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.createSubmission(u.orgId, vendorId, body);
  }

  @Patch("vendors/:vendorId/submissions")
  async updateSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query(new ZodValidationPipe(submissionIdQuerySchema)) query: SubmissionIdQueryInput,
    @Body(new ZodValidationPipe(updateSubmissionSchema)) body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.updateSubmission(vendorId, query.submissionId, body);
  }

  @Get("headcount")
  listHeadcount(
    @Query(new ZodValidationPipe(headcountListSchema)) query: HeadcountListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.listHeadcount(u.orgId, u.userId, u.role, query);
  }

  @Post("headcount")
  @HttpCode(201)
  createHeadcount(
    @Body(new ZodValidationPipe(createHeadcountSchema)) body: CreateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createHeadcount(u.orgId, u.userId, body);
  }

  @Patch("headcount/:requestId")
  updateHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(updateHeadcountSchema)) body: UpdateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateHeadcount(u.orgId, u.userId, requestId, body);
  }

  @Post("headcount/:requestId/approve")
  async approveHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.approveHeadcount(u.orgId, u.userId, requestId);
  }

  @Post("headcount/:requestId/reject")
  async rejectHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(rejectHeadcountSchema)) body: RejectHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.rejectHeadcount(u.orgId, requestId, body.reason);
  }

  @Post("headcount/:requestId/create-job")
  @HttpCode(201)
  async createJobFromHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.createJobFromHeadcount(u.orgId, u.userId, requestId);
  }

  @Get("external-referrals")
  listExternalReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listExternalReferrals(u.orgId);
  }

  @Patch("external-referrals/:referralId")
  async updateExternalReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body(new ZodValidationPipe(updateExternalReferralSchema)) body: UpdateExternalReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.updateExternalReferral(u.orgId, referralId, body);
  }

  @Get("external-referrers")
  async listExternalReferrers(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.listExternalReferrers(u.orgId);
  }

  @Patch("external-referrers/:referrerId")
  async updateExternalReferrerStatus(
    @Param("referrerId", ParseIntPipe) referrerId: number,
    @Body(new ZodValidationPipe(updateExternalReferrerStatusSchema)) body: UpdateExternalReferrerStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.sourcing.updateExternalReferrerStatus(u.orgId, referrerId, body);
  }
}
