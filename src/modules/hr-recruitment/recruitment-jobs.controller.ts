import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentJobsService } from "./recruitment-jobs.service";
import { RECRUITMENT_ADMIN_ROLES, RECRUITMENT_MANAGER_ROLES } from "./recruitment-roles";
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

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class RecruitmentJobsController {
  constructor(private readonly jobs: RecruitmentJobsService) {}

  @Get("jobs")
  list(
    @Query(new ZodValidationPipe(jobListSchema)) query: JobListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.list(u.orgId, query);
  }

  @Post("jobs")
  @HttpCode(201)
  @CheckAbility("manage", "hr:employees")
  create(
    @Body(new ZodValidationPipe(createJobSchema)) body: CreateJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.create(u.orgId, u.userId, body);
  }

  @Get("jobs/:jobId")
  getOne(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.getOne(u.orgId, jobId);
  }

  @Patch("jobs/:jobId")
  @CheckAbility("manage", "hr:employees")
  update(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(updateJobSchema)) body: UpdateJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.update(u.orgId, jobId, body);
  }

  @Delete("jobs/:jobId")
  @CheckAbility("manage", "hr:employees")
  remove(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.remove(u.orgId, jobId);
  }

  @Post("jobs/:jobId/publish")
  publish(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(publishJobSchema)) body: PublishJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.jobs.publish(u.orgId, jobId, body);
  }

  @Get("jobs/:jobId/recruiters")
  listRecruiters(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.listRecruiters(u.orgId, jobId);
  }

  @Post("jobs/:jobId/recruiters")
  @HttpCode(201)
  assignRecruiter(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(assignRecruiterSchema)) body: AssignRecruiterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_MANAGER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.jobs.assignRecruiter(u.orgId, u.userId, jobId, body);
  }

  @Delete("jobs/:jobId/recruiters")
  removeRecruiter(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(assignRecruiterSchema)) body: AssignRecruiterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_MANAGER_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.jobs.removeRecruiter(jobId, body);
  }

  @Get("jobs/:jobId/share")
  share(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.share(u.orgId, jobId);
  }

  @Get("internal-jobs")
  listInternalJobs(@CurrentUser() u: CurrentUserContext) {
    return this.jobs.listInternalJobs(u.orgId);
  }

  @Post("internal-jobs/:jobId/apply")
  @HttpCode(201)
  internalApply(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(internalApplySchema)) body: InternalApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.internalApply(u.orgId, u.userId, jobId, body);
  }
}
