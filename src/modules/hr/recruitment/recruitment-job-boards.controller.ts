import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentJobBoardsService } from "./recruitment-job-boards.service";
import {
  createJobBoardPostingSchema,
  updateJobBoardPostingSchema,
  type CreateJobBoardPostingInput,
  type UpdateJobBoardPostingInput,
} from "./dto/job-boards.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  jobBoardPostingSchema,
} from "./dto/recruitment-response.schemas";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();
const jobAndPostingIdParams = z.object({ jobId: z.coerce.number().int().positive(), postingId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/jobs/:jobId/board-postings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentJobBoardsController {
  constructor(private readonly service: RecruitmentJobBoardsService) {}

  @Get()
  @ResponseSchema(z.array(jobBoardPostingSchema))
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: jobIdParams })
  list(@CurrentUser() u: CurrentUserContext, @Param("jobId", ParseIntPipe) jobId: number) {
    return this.service.list(u.orgId, jobId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(jobBoardPostingSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: jobIdParams, body: createJobBoardPostingSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: CreateJobBoardPostingInput,
  ) {
    return this.service.create(u.orgId, u.userId, jobId, body);
  }

  @Patch(":postingId")
  @ResponseSchema(jobBoardPostingSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: jobAndPostingIdParams, body: updateJobBoardPostingSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Param("postingId", ParseIntPipe) postingId: number,
    @Body() body: UpdateJobBoardPostingInput,
  ) {
    return this.service.update(u.orgId, jobId, postingId, body);
  }

  @Delete(":postingId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: jobAndPostingIdParams })
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Param("postingId", ParseIntPipe) postingId: number,
  ) {
    return this.service.remove(u.orgId, jobId, postingId);
  }
}
