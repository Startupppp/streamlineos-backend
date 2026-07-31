import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RecruitmentJobBoardsService } from "./recruitment-job-boards.service";
import {
  createJobBoardPostingSchema,
  updateJobBoardPostingSchema,
  type CreateJobBoardPostingInput,
  type UpdateJobBoardPostingInput,
} from "./dto/job-boards.schemas";

@RequireModule("hr")
@Controller("hr/recruitment/jobs/:jobId/board-postings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentJobBoardsController {
  constructor(private readonly service: RecruitmentJobBoardsService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext, @Param("jobId", ParseIntPipe) jobId: number) {
    return this.service.list(u.orgId, jobId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(createJobBoardPostingSchema)) body: CreateJobBoardPostingInput,
  ) {
    return this.service.create(u.orgId, u.userId, jobId, body);
  }

  @Patch(":postingId")
  @RequirePermission("hr:employees:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Param("postingId", ParseIntPipe) postingId: number,
    @Body(new ZodValidationPipe(updateJobBoardPostingSchema)) body: UpdateJobBoardPostingInput,
  ) {
    return this.service.update(u.orgId, jobId, postingId, body);
  }

  @Delete(":postingId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Param("postingId", ParseIntPipe) postingId: number,
  ) {
    return this.service.remove(u.orgId, jobId, postingId);
  }
}
