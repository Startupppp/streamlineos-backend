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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  jobPostingListResponseSchema,
  jobPostingSchema,
  jobPostingWithApplicationsSchema,
  successSchema,
  jobPublishResponseSchema,
  jobRecruiterSchema,
  assignRecruiterResponseSchema,
  jobShareResponseSchema,
  internalJobSchema,
  jobApplicationSchema,
} from "./dto/recruitment-response.schemas";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentJobsController {
  constructor(private readonly jobs: RecruitmentJobsService) {}

  @Get("jobs")
  @ResponseSchema(jobPostingListResponseSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: jobListSchema })
  list(
    @Query() query: JobListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.list(u.orgId, query);
  }

  @Post("jobs")
  @HttpCode(201)
  @ResponseSchema(jobPostingSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: createJobSchema })
  create(
    @Body() body: CreateJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.create(u.orgId, u.userId, body);
  }

  @Get("jobs/:jobId")
  @ResponseSchema(jobPostingWithApplicationsSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: jobIdParams })
  getOne(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.getOne(u.orgId, jobId);
  }

  @Patch("jobs/:jobId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: jobIdParams, body: updateJobSchema })
  update(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: UpdateJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.update(u.orgId, jobId, body);
  }

  @Delete("jobs/:jobId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: jobIdParams })
  async remove(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.jobs.remove(u.orgId, jobId);
  }

  @Post("jobs/:jobId/publish")
  @ResponseSchema(jobPublishResponseSchema)
  @Idempotent("hr.job.publish")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: jobIdParams, body: publishJobSchema })
  publish(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: PublishJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.publish(u.orgId, jobId, body);
  }

  @Post("jobs/:jobId/duplicate")
  @BodylessAction()
  @HttpCode(201)
  @ResponseSchema(jobPostingSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: jobIdParams })
  duplicate(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.duplicate(u.orgId, u.userId, jobId);
  }

  @Get("jobs/:jobId/recruiters")
  @ResponseSchema(z.array(jobRecruiterSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: jobIdParams })
  listRecruiters(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.listRecruiters(u.orgId, jobId);
  }

  @Post("jobs/:jobId/recruiters")
  @HttpCode(201)
  @ResponseSchema(assignRecruiterResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: jobIdParams, body: assignRecruiterSchema })
  assignRecruiter(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: AssignRecruiterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.assignRecruiter(u.orgId, u.userId, jobId, body);
  }

  @Delete("jobs/:jobId/recruiters")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: jobIdParams, body: assignRecruiterSchema })
  async removeRecruiter(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: AssignRecruiterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.jobs.removeRecruiter(u.orgId, jobId, body);
  }

  @Get("jobs/:jobId/share")
  @ResponseSchema(jobShareResponseSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: jobIdParams })
  share(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.share(u.orgId, jobId);
  }

  @Get("internal-jobs")
  @ResponseSchema(z.array(internalJobSchema))
  @RequirePermission("hr:requisitions:view")
  listInternalJobs(@CurrentUser() u: CurrentUserContext) {
    return this.jobs.listInternalJobs(u.orgId);
  }

  @Post("internal-jobs/:jobId/apply")
  @HttpCode(201)
  @ResponseSchema(jobApplicationSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: jobIdParams, body: internalApplySchema })
  internalApply(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: InternalApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.internalApply(u.orgId, u.userId, jobId, body);
  }
}
