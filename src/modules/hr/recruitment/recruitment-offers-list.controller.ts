import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { offerListSchema, type OfferListInput } from "./dto/candidate-records.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { offerListResponseSchema } from "./dto/recruitment-response.schemas";

@RequireModule("hr")
@Controller("hr/recruitment/offers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentOffersListController {
  constructor(private readonly offers: RecruitmentOffersService) {}

  @Get()
  @ResponseSchema(offerListResponseSchema)
  @RequirePermission("hr:offers:view")
  @Validate({ query: offerListSchema })
  listAll(
    @Query() query: OfferListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.listAllOffers(u.orgId, query);
  }
}
