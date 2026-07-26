import { Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { TimesheetsAiService } from "./timesheets-ai.service";

@RequireModule("projects")
@Controller("timesheets/periods")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetsAiController {
  constructor(private readonly ai: TimesheetsAiService) {}

  @Post(":periodId/ai/summarize")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:view")
  @UseRateLimit("ai:invoke")
  summarize(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.summarizePeriod(u, periodId);
  }
}
