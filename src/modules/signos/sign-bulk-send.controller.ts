import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignBulkSendService } from "./sign-bulk-send.service";
import { createBulkSendJobSchema, type CreateBulkSendJobInput } from "./dto/signos.schemas";

@RequireModule("sign")
@Controller("sign/bulk-send")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignBulkSendController {
  constructor(private readonly bulkSend: SignBulkSendService) {}

  @Post("jobs")
  @RequirePermission("sign:bulk_send:run")
  create(@Body(new ZodValidationPipe(createBulkSendJobSchema)) body: CreateBulkSendJobInput, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.createJob(u.orgId, u.userId, body);
  }

  @Get("jobs/:id")
  @RequirePermission("sign:bulk_send:run")
  get(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getJob(u.orgId, id);
  }

  @Post("jobs/:id/cancel")
  @RequirePermission("sign:bulk_send:run")
  cancel(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.cancel(u.orgId, id, { userId: u.userId });
  }

  @Get("jobs/:id/error-report")
  @RequirePermission("sign:bulk_send:run")
  errorReport(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getErrorReport(u.orgId, id);
  }
}
