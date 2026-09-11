import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { notificationsDispatchResponseSchema } from "../dto/email-response.schemas";
import { EmailRoutesService } from "../email-routes.service";
import { dispatchSchema, type DispatchInput } from "../dto/email.schemas";

@Controller("notifications")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationsDispatchController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Post("dispatch")
  @Idempotent("notifications.dispatch")
  @HttpCode(200)
  @ResponseSchema(notificationsDispatchResponseSchema)
  @RequirePermission("notifications:events:manage")
  @Validate({ body: dispatchSchema })
  dispatch(@Body() body: DispatchInput) {
    return this.routes.dispatch(body);
  }
}
