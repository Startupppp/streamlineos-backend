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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RECRUITMENT_OFFER_ROLES } from "./recruitment-roles";
import {
  approvalRemarksSchema,
  createOfferSchema,
  updateOfferSchema,
  type ApprovalRemarksInput,
  type CreateOfferInput,
  type UpdateOfferInput,
} from "./dto/candidate-records.schemas";

@Controller("hr/recruitment/candidates/:candidateId/offers")
@UseGuards(JwtAuthGuard)
export class RecruitmentOffersController {
  constructor(private readonly offers: RecruitmentOffersService) {}

  @Get()
  list(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_OFFER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.offers.listOffers(u.orgId, candidateId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(createOfferSchema)) body: CreateOfferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_OFFER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.offers.createOffer(u.orgId, u.userId, candidateId, body);
  }

  @Post(":offerId/submit-for-approval")
  submitForApproval(
    @Param("offerId", ParseIntPipe) offerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (u.role !== "HR" && u.role !== "ADMIN") {
      throw new ForbiddenException("Only HR or Admin can submit offers for approval.");
    }
    return this.offers.submitForApproval(u.orgId, offerId);
  }

  @Post(":offerId/approve")
  approve(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(approvalRemarksSchema)) body: ApprovalRemarksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (u.role !== "CEO") throw new ForbiddenException("Only CEO can approve offers.");
    return this.offers.approveOffer(u.orgId, u.userId, offerId, body.remarks);
  }

  @Post(":offerId/reject-approval")
  rejectApproval(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(approvalRemarksSchema)) body: ApprovalRemarksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (u.role !== "CEO") throw new ForbiddenException("Only CEO can reject offer approvals.");
    return this.offers.rejectApproval(u.orgId, offerId, body.remarks);
  }

  @Patch(":offerId")
  update(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body(new ZodValidationPipe(updateOfferSchema)) body: UpdateOfferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_OFFER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.offers.updateOffer(u.orgId, candidateId, offerId, body);
  }

  @Delete(":offerId")
  remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("offerId", ParseIntPipe) offerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_OFFER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.offers.deleteOffer(u.orgId, candidateId, offerId);
  }
}
