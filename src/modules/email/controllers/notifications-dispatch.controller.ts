import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { EmailRoutesService } from "../email-routes.service";
import { dispatchSchema } from "../dto/email.schemas";

@Controller("notifications")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationsDispatchController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Post("dispatch")
  @HttpCode(200)
  @RequirePermission("notifications:events:manage")
  dispatch(@Body() raw: unknown, @CurrentUser() _u: CurrentUserContext) {
    const body = dispatchSchema.parse(raw);
    return this.routes.dispatch(body);
  }
}
