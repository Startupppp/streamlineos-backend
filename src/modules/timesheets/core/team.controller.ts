import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { TeamService } from "./team.service";
import { teamWeekSummaryQuerySchema, type TeamWeekSummaryQuery } from "./dto/team.schemas";

@RequireModule("build")
@Controller("timesheets/team")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get("week-summary")
  @RequirePermission("timesheets:team:view")
  getWeekSummary(
    @Query(new ZodValidationPipe(teamWeekSummaryQuerySchema)) query: TeamWeekSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.team.getWeekSummary(u, query);
  }
}
