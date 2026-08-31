import {
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { CommandCenterService } from "./command-center.service";
import { commandCenterQuerySchema, type CommandCenterQuery } from "./dto/runs.schemas";

@RequireModule("payroll")
@Controller("payroll/command-center")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class CommandCenterController {
  constructor(private readonly commandCenterService: CommandCenterService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @Validate({ query: commandCenterQuerySchema })
  async get(
    @Query() query: CommandCenterQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.commandCenterService.getCommandCenter(u.orgId, query);
  }
}
