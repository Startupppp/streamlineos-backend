import { Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { GoogleCalendarService } from "./google-calendar.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("calendar")
@Controller("calendar")
@UseGuards(JwtAuthGuard)
export class GoogleCalendarController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @Get("create-meet")
  getStatus(@CurrentUser() u: CurrentUserContext) {
    return this.googleCalendar.getStatus(u.userId);
  }

  @Post("create-meet")
  @HttpCode(200)
  createMeet(@CurrentUser() u: CurrentUserContext) {
    return this.googleCalendar.createMeet(u.userId);
  }
}
