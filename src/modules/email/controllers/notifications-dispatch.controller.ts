import { Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { EmailRoutesService } from "../email-routes.service";
import { dispatchSchema } from "../dto/email.schemas";

@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsDispatchController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Post("dispatch")
  @HttpCode(200)
  dispatch(@Body() raw: unknown, @CurrentUser() u: CurrentUserContext) {
    if (u.role !== "CEO" && u.role !== "HR" && u.role !== "ADMIN") {
      throw new ForbiddenException("Forbidden");
    }
    const body = dispatchSchema.parse(raw);
    return this.routes.dispatch(body);
  }
}
