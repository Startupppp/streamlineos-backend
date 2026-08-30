import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { EmailRoutesService } from "../email-routes.service";
import { dispatchSchema } from "../dto/email.schemas";

@Controller("notifications")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationsDispatchController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Post("dispatch")
  @Idempotent("notifications.dispatch")
  @HttpCode(200)
  @RequirePermission("notifications:events:manage")
  dispatch(@Body() raw: unknown) {
    const body = dispatchSchema.parse(raw);
    return this.routes.dispatch(body);
  }
}
