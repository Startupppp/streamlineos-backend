import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
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
  @RequirePermission("hr:requisitions:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createRequisitionSchema)) body: CreateRequisitionInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":id/submit")
  @RequirePermission("hr:requisitions:manage")
  submit(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.submit(u.orgId, id);
  }

  @Patch(":id/approve")
  @RequirePermission("hr:requisitions:manage")
  approve(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.approve(u.orgId, id, u.userId);
  }

  @Patch(":id/reject")
  @RequirePermission("hr:requisitions:manage")
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(rejectRequisitionSchema)) body: RejectRequisitionInput,
  ) {
    return this.service.reject(u.orgId, id, u.userId, body.reason ?? "");
  }

  @Post(":id/create-job")
  @RequirePermission("hr:requisitions:manage")
  createJob(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.createJobFromRequisition(u.orgId, u.userId, id);
  }

  @Patch(":id")
  @RequirePermission("hr:requisitions:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateRequisitionSchema)) body: UpdateRequisitionInput,
  ) {
    return this.service.update(u.orgId, id, body);
  }
}
