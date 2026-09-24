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
  createReferralSubmissionSchema,
  createSubmissionSchema,
  createVendorSchema,
  submissionIdQuerySchema,
  updateExternalReferralSchema,
  updateExternalReferrerStatusSchema,
  updateReferralStatusSchema,
  updateSubmissionSchema,
  updateVendorSchema,
  type CreateReferralSubmissionInput,
  type CreateSubmissionInput,
  type CreateVendorInput,
  type SubmissionIdQueryInput,
  type UpdateExternalReferralInput,
  type UpdateExternalReferrerStatusInput,
  type UpdateReferralStatusInput,
  type UpdateSubmissionInput,
  type UpdateVendorInput,
} from "./dto/sourcing.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  candidateReferralWithRelationsSchema,
  candidateReferralRowSchema,
  vendorListItemSchema,
  vendorRowSchema,
  vendorPortalLinkSchema,
  vendorSubmissionItemSchema,
  vendorSubmissionRawSchema,
  externalReferralWithRelationsSchema,
  externalReferralRawSchema,
  externalReferrerListItemSchema,
  externalReferrerRowSchema,
} from "./dto/recruitment-response.schemas";

const referralIdParams = z.object({ referralId: z.coerce.number().int().positive() }).strict();
const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();
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
  @ResponseSchema(z.array(candidateReferralWithRelationsSchema))
  @RequirePermission("hr:requisitions:view")
  async listReferrals(@CurrentUser() u: CurrentUserContext) {
    const canManage = u.isOrgOwner
      || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listReferrals(u.orgId, u.userId, canManage, actingMembershipId(u.principal));
  }

  @Post("referrals")
  @Idempotent("hr.sourcing.referral-create")
  @HttpCode(201)
  @ResponseSchema(candidateReferralRowSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ body: createReferralSubmissionSchema })
  createReferral(
    @Body() body: CreateReferralSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createReferral(u.orgId, u.userId, body, actingMembershipId(u.principal));
  }

  @Patch("referrals/:referralId")
  @ResponseSchema(candidateReferralRowSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: referralIdParams, body: updateReferralStatusSchema })
  updateReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body() body: UpdateReferralStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateReferralStatus(u.orgId, referralId, body);
  }

  @Get("vendors")
  @ResponseSchema(z.array(vendorListItemSchema))
  @RequirePermission("hr:requisitions:view")
  listVendors(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listVendors(u.orgId);
  }

  @Post("vendors")
  @HttpCode(201)
  @ResponseSchema(vendorRowSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ body: createVendorSchema })
  createVendor(@Body() body: CreateVendorInput, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.createVendor(u.orgId, u.userId, body);
  }

  @Patch("vendors/:vendorId")
  @ResponseSchema(vendorRowSchema)
  @RequirePermission("hr:requisitions:manage")
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
  @NoContentResponse()
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: vendorIdParams })
  async deleteVendor(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    await this.sourcing.deleteVendor(u.orgId, vendorId);
  }

  @Post("vendors/:vendorId/portal-link")
  @BodylessAction()
  @HttpCode(201)
  @ResponseSchema(vendorPortalLinkSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: vendorIdParams })
  generateVendorPortalLink(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.generateVendorPortalLink(u.orgId, vendorId);
  }

  @Get("vendors/:vendorId/submissions")
  @ResponseSchema(z.array(vendorSubmissionItemSchema))
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: vendorIdParams })
  async listSubmissions(@Param("vendorId", ParseIntPipe) vendorId: number, @CurrentUser() u: CurrentUserContext) {
    /**
     * Vendor fee and margin are money, so the narrower rung of the same family
     * the rest of this desk uses decides it. It read `hr:employees:manage`,
     * which nothing else on this controller checks any more and which the
     * sidebar never grants.
     */
    const canViewFinancials =
      u.isOrgOwner || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listSubmissions(u.orgId, vendorId, canViewFinancials);
  }

  @Post("vendors/:vendorId/submissions")
  @HttpCode(201)
  @ResponseSchema(vendorSubmissionRawSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: vendorIdParams, body: createSubmissionSchema })
  createSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body() body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createSubmission(u.orgId, vendorId, body);
  }

  @Patch("vendors/:vendorId/submissions")
  @ResponseSchema(vendorSubmissionRawSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: vendorIdParams, query: submissionIdQuerySchema, body: updateSubmissionSchema })
  updateSubmission(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query() query: SubmissionIdQueryInput,
    @Body() body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateSubmission(u.orgId, vendorId, query.submissionId, body);
  }

  @Get("external-referrals")
  @ResponseSchema(z.array(externalReferralWithRelationsSchema))
  @RequirePermission("hr:requisitions:view")
  listExternalReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listExternalReferrals(u.orgId);
  }

  @Patch("external-referrals/:referralId")
  @ResponseSchema(externalReferralRawSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: referralIdParams, body: updateExternalReferralSchema })
  updateExternalReferral(
    @Param("referralId", ParseIntPipe) referralId: number,
    @Body() body: UpdateExternalReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateExternalReferral(u.orgId, referralId, body);
  }

  @Get("external-referrers")
  @ResponseSchema(z.array(externalReferrerListItemSchema))
  @RequirePermission("hr:requisitions:view")
  listExternalReferrers(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listExternalReferrers(u.orgId);
  }

  @Patch("external-referrers/:referrerId")
  @ResponseSchema(externalReferrerRowSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: referrerIdParams, body: updateExternalReferrerStatusSchema })
  updateExternalReferrerStatus(
    @Param("referrerId", ParseIntPipe) referrerId: number,
    @Body() body: UpdateExternalReferrerStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateExternalReferrerStatus(u.orgId, referrerId, body);
  }
}
