import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
  UsePipes,
  Body,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmInboxService } from "./crm-inbox.service";
import { snoozeTaskSchema, type SnoozeTaskInput } from "./crm-inbox.dto";

const SCOPES = ["all", "team", "own", "none"] as const;
type Scope = (typeof SCOPES)[number];

function readScope(req: Request): Scope {
  const raw = (req as Request & { rbacScope?: string }).rbacScope;
  return SCOPES.find((s) => s === raw) ?? "all";
}

@Controller("crm/inbox")
@RequireModule("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmInboxController {
  constructor(private readonly svc: CrmInboxService) {}

  @Get()
  @RequirePermission("crm:leads:view")
  async getInbox(@Req() req: Request, @CurrentUser() user: CurrentUserContext) {
    return this.svc.getInbox(user.orgId, user.userId, readScope(req));
  }

  @Get("counts")
  @RequirePermission("crm:leads:view")
  async getCounts(@Req() req: Request, @CurrentUser() user: CurrentUserContext) {
    return this.svc.getCounts(user.orgId, user.userId, readScope(req));
  }

  @Post("tasks/:taskId/snooze")
  @RequirePermission("crm:tasks:update")
  @UsePipes(new ZodValidationPipe(snoozeTaskSchema))
  async snoozeTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() body: SnoozeTaskInput,
    @Req() req: Request,
    @CurrentUser() user: CurrentUserContext,
  ) {
    await this.svc.snoozeTask(user.orgId, taskId, user.userId, body, readScope(req));
    return { success: true };
  }

  @Post("tasks/:taskId/complete")
  @RequirePermission("crm:tasks:update")
  async completeTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Req() req: Request,
    @CurrentUser() user: CurrentUserContext,
  ) {
    await this.svc.completeTask(user.orgId, taskId, user.userId, readScope(req));
    return { success: true };
  }
}
