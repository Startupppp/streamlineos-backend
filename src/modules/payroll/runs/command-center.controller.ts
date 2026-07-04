import {
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CommandCenterService } from "./command-center.service";
import { commandCenterQuerySchema, type CommandCenterQuery } from "./dto/runs.schemas";

@Controller("payroll/command-center")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CommandCenterController {
  constructor(private readonly commandCenterService: CommandCenterService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  async get(
    @Query(new ZodValidationPipe(commandCenterQuerySchema)) query: CommandCenterQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.commandCenterService.getCommandCenter(u.orgId, query);
  }
}
