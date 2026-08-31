import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentRequisitionsService } from "./recruitment-requisitions.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  requisitionListSchema,
  createRequisitionSchema,
  updateRequisitionSchema,
  rejectRequisitionSchema,
  type RequisitionListInput,
  type CreateRequisitionInput,
  type UpdateRequisitionInput,
  type RejectRequisitionInput,
} from "./dto/requisitions.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const requisitionIdParams = z.object({ requisitionId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/recruitment/requisitions")
export class RecruitmentRequisitionsController {
  constructor(private readonly service: RecruitmentRequisitionsService) {}

  @Get()
  @RequirePermission("hr:requisitions:view")
  @Validate({ query: requisitionListSchema })
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: RequisitionListInput,
  ) {
    return this.service.list(u.orgId, query.status);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ body: createRequisitionSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateRequisitionInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":requisitionId/submit")
  @Idempotent("hr.requisition.submit")
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: requisitionIdParams })
  submit(@CurrentUser() u: CurrentUserContext, @Param("requisitionId", ParseIntPipe) requisitionId: number) {
    return this.service.submit(u.orgId, requisitionId);
  }

  @Patch(":requisitionId/approve")
  @BodylessAction()
  @Idempotent("hr.requisition.approve")
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: requisitionIdParams })
  approve(@CurrentUser() u: CurrentUserContext, @Param("requisitionId", ParseIntPipe) requisitionId: number) {
    return this.service.approve(u.orgId, requisitionId, u.userId);
  }

  @Patch(":requisitionId/reject")
  @Idempotent("hr.requisition.reject")
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: requisitionIdParams, body: rejectRequisitionSchema })
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("requisitionId", ParseIntPipe) requisitionId: number,
    @Body() body: RejectRequisitionInput,
  ) {
    return this.service.reject(u.orgId, requisitionId, u.userId, body.reason ?? "");
  }

  @Post(":requisitionId/create-job")
  @HttpCode(201)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: requisitionIdParams })
  createJob(@CurrentUser() u: CurrentUserContext, @Param("requisitionId", ParseIntPipe) requisitionId: number) {
    return this.service.createJobFromRequisition(u.orgId, u.userId, requisitionId);
  }

  @Patch(":requisitionId")
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: requisitionIdParams, body: updateRequisitionSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("requisitionId", ParseIntPipe) requisitionId: number,
    @Body() body: UpdateRequisitionInput,
  ) {
    return this.service.update(u.orgId, requisitionId, body);
  }
}
