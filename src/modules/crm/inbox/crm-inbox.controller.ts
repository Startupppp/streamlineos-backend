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
import { readRequestScope } from "../../organization/core/read-request-scope";
import { CrmInboxService } from "./crm-inbox.service";
import { snoozeTaskSchema, type SnoozeTaskInput } from "./crm-inbox.dto";

@Controller("crm/inbox")
@RequireModule("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmInboxController {
  constructor(private readonly svc: CrmInboxService) {}

  @Get()
  @RequirePermission("crm:leads:view")
  async getInbox(@Req() req: Request, @CurrentUser() user: CurrentUserContext) {
    return this.svc.getInbox(user.orgId, user.userId, readRequestScope(req));
  }

  @Get("counts")
  @RequirePermission("crm:leads:view")
  async getCounts(@Req() req: Request, @CurrentUser() user: CurrentUserContext) {
    return this.svc.getCounts(user.orgId, user.userId, readRequestScope(req));
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
    await this.svc.snoozeTask(user.orgId, taskId, user.userId, body, readRequestScope(req));
    return { success: true };
  }

  @Post("tasks/:taskId/complete")
  @RequirePermission("crm:tasks:update")
  async completeTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Req() req: Request,
    @CurrentUser() user: CurrentUserContext,
  ) {
    await this.svc.completeTask(user.orgId, taskId, user.userId, readRequestScope(req));
    return { success: true };
  }
}
