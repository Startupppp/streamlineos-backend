import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { SignBulkSendService } from "./sign-bulk-send.service";
import { createBulkSendJobSchema, type CreateBulkSendJobInput } from "./dto/e-sign.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  createBulkJobResponseSchema,
  listBulkJobsResponseSchema,
  getBulkJobResponseSchema,
  cancelBulkJobResponseSchema,
  bulkJobErrorReportResponseSchema,
} from "./dto/e-sign-response.schemas";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/bulk-send")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignBulkSendController {
  constructor(private readonly bulkSend: SignBulkSendService) {}

  @Post("jobs")
  @HttpCode(201)
  @Idempotent("sign:bulk_send.create")
  @RequirePermission("sign:bulk_send:run")
  @ResponseSchema(createBulkJobResponseSchema)
  @Validate({ body: createBulkSendJobSchema })
  create(@Body() body: CreateBulkSendJobInput, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.createJob(u.orgId, actingMembershipId(u.principal), body);
  }

  @Get("jobs")
  @RequirePermission("sign:bulk_send:run")
  @ResponseSchema(listBulkJobsResponseSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.listJobs(u.orgId);
  }

  @Get("jobs/:jobId")
  @RequirePermission("sign:bulk_send:run")
  @ResponseSchema(getBulkJobResponseSchema)
  @Validate({ params: jobIdParams })
  get(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getJob(u.orgId, jobId);
  }

  @Post("jobs/:jobId/cancel")
  @BodylessAction()
  @RequirePermission("sign:bulk_send:run")
  @ResponseSchema(cancelBulkJobResponseSchema)
  @Validate({ params: jobIdParams })
  cancel(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.cancel(u.orgId, jobId, { userId: u.userId });
  }

  @Get("jobs/:jobId/error-report")
  @RequirePermission("sign:bulk_send:run")
  @ResponseSchema(bulkJobErrorReportResponseSchema)
  @Validate({ params: jobIdParams })
  errorReport(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getErrorReport(u.orgId, jobId);
  }
}
