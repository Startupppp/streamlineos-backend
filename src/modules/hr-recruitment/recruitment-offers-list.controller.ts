import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/recruitment/offers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentOffersListController {
  constructor(private readonly offers: RecruitmentOffersService) {}

  @Get()
  @RequirePermission("hr:offers:view")
  listAll(@CurrentUser() u: CurrentUserContext) {
    return this.offers.listAllOffers(u.orgId);
  }
}
