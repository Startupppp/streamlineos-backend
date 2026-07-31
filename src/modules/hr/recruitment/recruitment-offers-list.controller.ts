import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { offerListSchema, type OfferListInput } from "./dto/candidate-records.schemas";

@RequireModule("hr")
@Controller("hr/recruitment/offers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentOffersListController {
  constructor(private readonly offers: RecruitmentOffersService) {}

  @Get()
  @RequirePermission("hr:offers:view")
  listAll(
    @Query(new ZodValidationPipe(offerListSchema)) query: OfferListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.offers.listAllOffers(u.orgId, query);
  }
}
