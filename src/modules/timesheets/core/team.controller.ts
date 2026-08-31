import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TeamService } from "./team.service";
import { teamWeekSummaryQuerySchema, type TeamWeekSummaryQuery } from "./dto/team.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("build")
@Controller("timesheets/team")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get("week-summary")
  @RequirePermission("timesheets:team:view")
  @Validate({ query: teamWeekSummaryQuerySchema })
  getWeekSummary(
    @Query() query: TeamWeekSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.team.getWeekSummary(u, query);
  }
}
