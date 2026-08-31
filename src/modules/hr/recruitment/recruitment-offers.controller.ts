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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();
const candidateAndOfferIdParams = z.object({ candidateId: z.coerce.number().int().positive(), offerId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/offers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentOffersController {
  constructor(private readonly offers: RecruitmentOffersService) {}

  @Get()
  @RequirePermission("hr:offers:view")
  @Validate({ params: candidateIdParams })
  list(@Param("candidateId", ParseIntPipe) candidateId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.listOffers(u.orgId, candidateId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:offers:manage")
  @Validate({ params: candidateIdParams, body: createOfferSchema })
  create(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: CreateOfferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.createOffer(u.orgId, u.userId, candidateId, body);
  }

  @Post(":offerId/submit-for-approval")
  @BodylessAction()
  @Idempotent("hr.offer.submit-approval")
  @RequirePermission("hr:offers:manage")
  @Validate({ params: candidateAndOfferIdParams })
  submitForApproval(@Param("offerId", ParseIntPipe) offerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.submitForApproval(u.orgId, offerId, u.userId);
  }

  @Post(":offerId/approve")
  @Idempotent("hr.offer.approve")
  @RequirePermission("hr:offers:approve")
  @Validate({ params: candidateAndOfferIdParams, body: approvalRemarksSchema })
  approve(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body() body: ApprovalRemarksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.approveOffer(u.orgId, u.userId, offerId, body.remarks);
  }

  @Post(":offerId/reject-approval")
  @RequirePermission("hr:offers:approve")
  @Validate({ params: candidateAndOfferIdParams, body: approvalRemarksSchema })
  rejectApproval(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body() body: ApprovalRemarksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.rejectApproval(u.orgId, offerId, body.remarks, u.userId);
  }

  @Get(":offerId/versions")
  @RequirePermission("hr:offers:view")
  @Validate({ params: candidateAndOfferIdParams })
  listVersions(@Param("offerId", ParseIntPipe) offerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.listVersions(u.orgId, offerId);
  }

  @Get(":offerId/negotiations")
  @RequirePermission("hr:offers:view")
  @Validate({ params: candidateAndOfferIdParams })
  listNegotiations(@Param("offerId", ParseIntPipe) offerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.offers.listNegotiations(u.orgId, offerId);
  }

  @Post(":offerId/negotiations")
  @HttpCode(201)
  @RequirePermission("hr:offers:manage")
  @Validate({ params: candidateAndOfferIdParams, body: createOfferNegotiationSchema })
  respondToNegotiation(
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body() body: CreateOfferNegotiationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.addNegotiationEntry(u.orgId, offerId, "INTERNAL_RESPONSE", body, u.userId);
  }

  @Patch(":offerId")
  @RequirePermission("hr:offers:manage")
  @Validate({ params: candidateAndOfferIdParams, body: updateOfferSchema })
  update(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("offerId", ParseIntPipe) offerId: number,
    @Body() body: UpdateOfferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.updateOffer(u.orgId, u.userId, candidateId, offerId, body);
  }

  @Delete(":offerId")
  @RequirePermission("hr:offers:manage")
  @Validate({ params: candidateAndOfferIdParams })
  remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("offerId", ParseIntPipe) offerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.deleteOffer(u.orgId, candidateId, offerId, u.userId);
  }
}
