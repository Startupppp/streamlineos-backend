import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentJobsService } from "./recruitment-jobs.service";
import {
  assignRecruiterSchema,
  createJobSchema,
  internalApplySchema,
  jobListSchema,
  publishJobSchema,
  updateJobSchema,
  type AssignRecruiterInput,
  type CreateJobInput,
  type InternalApplyInput,
  type JobListInput,
  type PublishJobInput,
  type UpdateJobInput,
} from "./dto/jobs.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentJobsController {
  constructor(private readonly jobs: RecruitmentJobsService) {}

  @Get("jobs")
  @RequirePermission("hr:employees:view")
  list(
    @Query(new ZodValidationPipe(jobListSchema)) query: JobListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.list(u.orgId, query);
  }

  @Post("jobs")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  create(
    @Body(new ZodValidationPipe(createJobSchema)) body: CreateJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.create(u.orgId, u.userId, body);
  }

  @Get("jobs/:jobId")
  @RequirePermission("hr:employees:view")
  getOne(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.getOne(u.orgId, jobId);
  }

  @Patch("jobs/:jobId")
  @RequirePermission("hr:employees:manage")
  update(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(updateJobSchema)) body: UpdateJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.update(u.orgId, jobId, body);
  }

  @Delete("jobs/:jobId")
  @RequirePermission("hr:employees:manage")
  remove(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.remove(u.orgId, jobId);
  }

  @Post("jobs/:jobId/publish")
  @RequirePermission("hr:employees:manage")
  publish(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(publishJobSchema)) body: PublishJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.publish(u.orgId, jobId, body);
  }

  @Get("jobs/:jobId/recruiters")
  @RequirePermission("hr:employees:view")
  listRecruiters(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.listRecruiters(u.orgId, jobId);
  }

  @Post("jobs/:jobId/recruiters")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  assignRecruiter(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(assignRecruiterSchema)) body: AssignRecruiterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.assignRecruiter(u.orgId, u.userId, jobId, body);
  }

  @Delete("jobs/:jobId/recruiters")
  @RequirePermission("hr:employees:manage")
  removeRecruiter(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(assignRecruiterSchema)) body: AssignRecruiterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.removeRecruiter(jobId, body);
  }

  @Get("jobs/:jobId/share")
  @RequirePermission("hr:employees:view")
  share(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.share(u.orgId, jobId);
  }

  @Get("internal-jobs")
  @RequirePermission("hr:employees:view")
  listInternalJobs(@CurrentUser() u: CurrentUserContext) {
    return this.jobs.listInternalJobs(u.orgId);
  }

  @Post("internal-jobs/:jobId/apply")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  internalApply(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(internalApplySchema)) body: InternalApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.internalApply(u.orgId, u.userId, jobId, body);
  }
}
