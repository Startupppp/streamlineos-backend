import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
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
  @HttpCode(201)
  @RequirePermission("sign:bulk_send:run")
  create(@Body(new ZodValidationPipe(createBulkSendJobSchema)) body: CreateBulkSendJobInput, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.createJob(u.orgId, u.userId, body);
  }

  @Get("jobs")
  @RequirePermission("sign:bulk_send:run")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.listJobs(u.orgId);
  }

  @Get("jobs/:jobId")
  @RequirePermission("sign:bulk_send:run")
  get(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getJob(u.orgId, jobId);
  }

  @Post("jobs/:jobId/cancel")
  @RequirePermission("sign:bulk_send:run")
  cancel(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.cancel(u.orgId, jobId, { userId: u.userId });
  }

  @Get("jobs/:jobId/error-report")
  @RequirePermission("sign:bulk_send:run")
  errorReport(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getErrorReport(u.orgId, jobId);
  }
}
