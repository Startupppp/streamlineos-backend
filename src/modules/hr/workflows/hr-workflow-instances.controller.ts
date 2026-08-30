import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import {
  ActOnInstanceSchema,
  RejectInstanceSchema,
  WorkflowInstanceQuerySchema,
  type ActOnInstanceDto,
  type RejectInstanceDto,
  type WorkflowInstanceQueryDto,
} from "./dto/workflow.schemas";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import { HrWorkflowEngineService } from "./hr-workflow-engine.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";

const instanceIdParams = z.object({ instanceId: z.coerce.number().int().positive() }).strict();

const PaginationSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/workflows/instances")
export class HrWorkflowInstancesController {
  constructor(
    private readonly instancesService: HrWorkflowInstancesService,
    private readonly engine: HrWorkflowEngineService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  listAll(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(WorkflowInstanceQuerySchema)) query: WorkflowInstanceQueryDto,
  ) {
    return this.instancesService.listAll(u.orgId, query);
  }

  @Get("inbox")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:approve")
  inbox(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(PaginationSchema)) query: { page: number; limit: number },
  ) {
    return this.instancesService.getInbox(u.orgId, u.userId, query.page, query.limit);
  }

  @Get("acted")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:approve")
  acted(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(PaginationSchema)) query: { page: number; limit: number },
  ) {
    return this.instancesService.getMyActed(u.orgId, u.userId, query.page, query.limit);
  }

  @Get(":instanceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @Validate({ params: instanceIdParams })
  getDetail(
    @CurrentUser() u: CurrentUserContext,
    @Param("instanceId", ParseIntPipe) instanceId: number,
  ) {
    return this.instancesService.getDetail(u.orgId, instanceId);
  }

  @Post(":instanceId/approve")
  @Idempotent("hr.workflow-instance.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:approve")
  @HttpCode(200)
  @Validate({ params: instanceIdParams })
  approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("instanceId", ParseIntPipe) instanceId: number,
    @Body(new ZodValidationPipe(ActOnInstanceSchema)) body: ActOnInstanceDto,
  ) {
    return this.engine.act({
      orgId: u.orgId,
      instanceId,
      actorUserId: u.userId,
      action: "approved",
      comment: body.comment,
      attachments: body.attachments,
    });
  }

  @Post(":instanceId/reject")
  @Idempotent("hr.workflow-instance.reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:approve")
  @HttpCode(200)
  @Validate({ params: instanceIdParams })
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("instanceId", ParseIntPipe) instanceId: number,
    @Body(new ZodValidationPipe(RejectInstanceSchema)) body: RejectInstanceDto,
  ) {
    return this.engine.act({
      orgId: u.orgId,
      instanceId,
      actorUserId: u.userId,
      action: "rejected",
      comment: body.comment,
      attachments: body.attachments,
    });
  }

  @Post(":instanceId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @HttpCode(200)
  @Validate({ params: instanceIdParams })
  cancel(
    @CurrentUser() u: CurrentUserContext,
    @Param("instanceId", ParseIntPipe) instanceId: number,
    @Body(new ZodValidationPipe(ActOnInstanceSchema)) body: ActOnInstanceDto,
  ) {
    return this.engine.act({
      orgId: u.orgId,
      instanceId,
      actorUserId: u.userId,
      action: "cancelled",
      comment: body.comment,
    });
  }

  @Post(":instanceId/reopen")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @HttpCode(200)
  @Validate({ params: instanceIdParams })
  reopen(
    @CurrentUser() u: CurrentUserContext,
    @Param("instanceId", ParseIntPipe) instanceId: number,
    @Body(new ZodValidationPipe(ActOnInstanceSchema)) body: ActOnInstanceDto,
  ) {
    return this.engine.act({
      orgId: u.orgId,
      instanceId,
      actorUserId: u.userId,
      action: "reopened",
      comment: body.comment,
    });
  }

  @Post(":instanceId/comment")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:approve")
  @HttpCode(200)
  @Validate({ params: instanceIdParams })
  comment(
    @CurrentUser() u: CurrentUserContext,
    @Param("instanceId", ParseIntPipe) instanceId: number,
    @Body(new ZodValidationPipe(ActOnInstanceSchema)) body: ActOnInstanceDto,
  ) {
    return this.engine.act({
      orgId: u.orgId,
      instanceId,
      actorUserId: u.userId,
      action: "commented",
      comment: body.comment,
      attachments: body.attachments,
    });
  }
}
