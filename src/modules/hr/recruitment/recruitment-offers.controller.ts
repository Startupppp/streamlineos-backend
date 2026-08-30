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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import {
  approvalRemarksSchema,
  createOfferSchema,
  createOfferNegotiationSchema,
  updateOfferSchema,
  type ApprovalRemarksInput,
  type CreateOfferInput,
  type CreateOfferNegotiationInput,
  type UpdateOfferInput,
} from "./dto/candidate-records.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/offers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentOffersController {
  constructor(private readonly offers: RecruitmentOffersService) {}

  @Get()
  @RequirePermission("hr:offers:view")
  list(@Param("candidateId", ParseIntPipe) candidateId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.listOffers(u.orgId, candidateId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:offers:manage")
  create(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(createOfferSchema)) body: CreateOfferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.createOffer(u.orgId, u.userId, candidateId, body);
  }

  @Post(":offerId/submit-for-approval")
  @Idempotent("hr.offer.submit-approval")
  @RequirePermission("hr:offers:manage")
  submitForApproval(@Param("offerId", ParseIntPipe) offerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.submitForApproval(u.orgId, offerId, u.userId);
  }

  @Post(":offerId/approve")
  @Idempotent("hr.offer.approve")
  @RequirePermission("hr:offers:approve")
  approve(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(approvalRemarksSchema)) body: ApprovalRemarksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.approveOffer(u.orgId, u.userId, offerId, body.remarks);
  }

  @Post(":offerId/reject-approval")
  @RequirePermission("hr:offers:approve")
  rejectApproval(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(approvalRemarksSchema)) body: ApprovalRemarksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.rejectApproval(u.orgId, offerId, body.remarks, u.userId);
  }

  @Get(":offerId/versions")
  @RequirePermission("hr:offers:view")
  listVersions(@Param("offerId", ParseIntPipe) offerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.listVersions(u.orgId, offerId);
  }

  @Get(":offerId/negotiations")
  @RequirePermission("hr:offers:view")
  listNegotiations(@Param("offerId", ParseIntPipe) offerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.listNegotiations(u.orgId, offerId);
  }

  @Post(":offerId/negotiations")
  @HttpCode(201)
  @RequirePermission("hr:offers:manage")
  respondToNegotiation(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(createOfferNegotiationSchema)) body: CreateOfferNegotiationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.addNegotiationEntry(u.orgId, offerId, "INTERNAL_RESPONSE", body, u.userId);
  }

  @Patch(":offerId")
  @RequirePermission("hr:offers:manage")
  update(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(updateOfferSchema)) body: UpdateOfferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.updateOffer(u.orgId, u.userId, candidateId, offerId, body);
  }

  @Delete(":offerId")
  @RequirePermission("hr:offers:manage")
  remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("offerId", ParseIntPipe) offerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.deleteOffer(u.orgId, candidateId, offerId, u.userId);
  }
}
