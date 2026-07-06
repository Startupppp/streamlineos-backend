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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SubmissionsService } from "./submissions.service";
import {
  createSubmissionSchema,
  updateSubmissionSchema,
  type CreateSubmissionInput,
  type UpdateSubmissionInput,
} from "./dto/forms.schemas";

@RequireModule("projects")
@Controller("projects/:projectId/forms/:formId/submissions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SubmissionsController {
  constructor(private readonly svc: SubmissionsService) {}

  @Get()
  @RequirePermission("projects:forms:manage")
  listSubmissions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listSubmissions(u.orgId, projectId, formId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:forms:view")
  createSubmission(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(createSubmissionSchema)) body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createSubmission(u.orgId, u.userId, projectId, formId, body);
  }

  @Patch(":submissionId")
  @RequirePermission("projects:forms:manage")
  updateSubmission(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body(new ZodValidationPipe(updateSubmissionSchema)) body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSubmission(u.orgId, u.userId, projectId, formId, submissionId, body);
  }
}
