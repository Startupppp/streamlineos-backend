import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { SubmissionsService } from "./submissions.service";
import {
  createSubmissionSchema,
  updateSubmissionSchema,
  type CreateSubmissionInput,
  type UpdateSubmissionInput,
} from "./dto/forms.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  submissionRowSchema,
  submissionCreateResultSchema,
} from "./dto/forms-response.schemas";

const submissionIdParams = z.object({ submissionId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/forms/:formId/submissions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SubmissionsController {
  constructor(private readonly svc: SubmissionsService) {}

  @Get()
  @RequirePermission("build:forms:manage")
  @ResponseSchema(z.array(submissionRowSchema))
  listSubmissions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listSubmissions(u.orgId, projectId, formId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:forms:view")
  @ResponseSchema(submissionCreateResultSchema)
  @Validate({ body: createSubmissionSchema })
  createSubmission(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Body() body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createSubmission(u.orgId, u.userId, projectId, formId, body);
  }

  @Patch(":submissionId")
  @RequirePermission("build:forms:manage")
  @ResponseSchema(submissionRowSchema)
  @Validate({ params: submissionIdParams, body: updateSubmissionSchema })
  updateSubmission(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSubmission(u.orgId, u.userId, projectId, formId, submissionId, body);
  }
}
