import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentRequisitionsService } from "./recruitment-requisitions.service";
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

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/recruitment/requisitions")
export class RecruitmentRequisitionsController {
  constructor(private readonly service: RecruitmentRequisitionsService) {}

  @Get()
  @RequirePermission("hr:requisitions:view")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(requisitionListSchema)) query: RequisitionListInput,
  ) {
    return this.service.list(u.orgId, query.status);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:requisitions:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createRequisitionSchema)) body: CreateRequisitionInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":requisitionId/submit")
  @RequirePermission("hr:requisitions:manage")
  submit(@CurrentUser() u: CurrentUserContext, @Param("requisitionId", ParseIntPipe) requisitionId: number) {
    return this.service.submit(u.orgId, requisitionId);
  }

  @Patch(":requisitionId/approve")
  @RequirePermission("hr:requisitions:manage")
  approve(@CurrentUser() u: CurrentUserContext, @Param("requisitionId", ParseIntPipe) requisitionId: number) {
    return this.service.approve(u.orgId, requisitionId, u.userId);
  }

  @Patch(":requisitionId/reject")
  @RequirePermission("hr:requisitions:manage")
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("requisitionId", ParseIntPipe) requisitionId: number,
    @Body(new ZodValidationPipe(rejectRequisitionSchema)) body: RejectRequisitionInput,
  ) {
    return this.service.reject(u.orgId, requisitionId, u.userId, body.reason ?? "");
  }

  @Post(":requisitionId/create-job")
  @HttpCode(201)
  @RequirePermission("hr:requisitions:manage")
  createJob(@CurrentUser() u: CurrentUserContext, @Param("requisitionId", ParseIntPipe) requisitionId: number) {
    return this.service.createJobFromRequisition(u.orgId, u.userId, requisitionId);
  }

  @Patch(":requisitionId")
  @RequirePermission("hr:requisitions:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("requisitionId", ParseIntPipe) requisitionId: number,
    @Body(new ZodValidationPipe(updateRequisitionSchema)) body: UpdateRequisitionInput,
  ) {
    return this.service.update(u.orgId, requisitionId, body);
  }
}
