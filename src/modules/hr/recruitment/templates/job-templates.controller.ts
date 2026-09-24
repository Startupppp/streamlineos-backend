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
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { JobTemplatesService } from "./job-templates.service";
import {
  appliedJobTemplateSchema,
  applyJobTemplateSchema,
  createJobTemplateSchema,
  jobTemplateListResponseSchema,
  jobTemplateListSchema,
  jobTemplateSchema,
  updateJobTemplateSchema,
  type ApplyJobTemplateInput,
  type CreateJobTemplateInput,
  type JobTemplateListInput,
  type UpdateJobTemplateInput,
} from "./job-templates.schemas";

const jobTemplateIdParams = z
  .object({ jobTemplateId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("hr")
@Controller("hr/recruitment/job-templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class JobTemplatesController {
  constructor(private readonly templates: JobTemplatesService) {}

  @Get()
  @ResponseSchema(jobTemplateListResponseSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ query: jobTemplateListSchema })
  list(@Query() query: JobTemplateListInput, @CurrentUser() u: CurrentUserContext) {
    return this.templates.list(u.orgId, query);
  }

  @Get(":jobTemplateId")
  @ResponseSchema(jobTemplateSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: jobTemplateIdParams })
  getOne(
    @Param("jobTemplateId", ParseIntPipe) jobTemplateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.getOne(u.orgId, jobTemplateId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(jobTemplateSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ body: createJobTemplateSchema })
  create(@Body() body: CreateJobTemplateInput, @CurrentUser() u: CurrentUserContext) {
    return this.templates.create(u.orgId, u.userId, body);
  }

  @Patch(":jobTemplateId")
  @ResponseSchema(jobTemplateSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: jobTemplateIdParams, body: updateJobTemplateSchema })
  update(
    @Param("jobTemplateId", ParseIntPipe) jobTemplateId: number,
    @Body() body: UpdateJobTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, jobTemplateId, body);
  }

  @Delete(":jobTemplateId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: jobTemplateIdParams })
  remove(
    @Param("jobTemplateId", ParseIntPipe) jobTemplateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.remove(u.orgId, jobTemplateId);
  }

  /**
   * POST rather than GET because the half-typed draft is the request: it can
   * carry a 10,000-character description, which does not belong in a query
   * string. It is a pure read of `job_templates` all the same — no posting is
   * created here, so the create screen can preview a template and change its
   * mind.
   */
  @Post(":jobTemplateId/apply")
  @HttpCode(200)
  @ResponseSchema(appliedJobTemplateSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: jobTemplateIdParams, body: applyJobTemplateSchema })
  apply(
    @Param("jobTemplateId", ParseIntPipe) jobTemplateId: number,
    @Body() body: ApplyJobTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.applyToJob(u.orgId, jobTemplateId, body);
  }
}
