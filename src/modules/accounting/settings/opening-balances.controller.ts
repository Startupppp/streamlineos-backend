import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OpeningBalancesService } from "./opening-balances.service";
import { postOpeningBalancesSchema, type PostOpeningBalancesInput } from "./dto/settings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("accounting/opening-balances")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OpeningBalancesController {
  constructor(private readonly svc: OpeningBalancesService) {}

  @Get()
  @RequirePermission("accounting:journal:read")
  getOpeningBalance(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getOpeningBalance(u.orgId);
  }

  @Post()
  @RequirePermission("accounting:journal:create")
  @HttpCode(200)
  @Validate({ body: postOpeningBalancesSchema })
  postOpeningBalances(
    @Body() body: PostOpeningBalancesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.postOpeningBalances(u, body);
  }
}
