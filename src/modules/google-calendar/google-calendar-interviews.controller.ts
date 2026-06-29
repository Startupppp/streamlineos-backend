import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { GoogleCalendarService } from "./google-calendar.service";
import { syncInterviewSchema, type SyncInterviewInput } from "./dto/google-calendar.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("calendar")
@Controller("hr/integrations/google-calendar")
@UseGuards(JwtAuthGuard)
export class GoogleCalendarInterviewsController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @Post()
  @HttpCode(200)
  syncInterview(
    @Body(new ZodValidationPipe(syncInterviewSchema)) body: SyncInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.googleCalendar.syncInterview(u.orgId, u.userId, body.interviewId);
  }
}
