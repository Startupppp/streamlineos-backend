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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrFormsService } from "./hr-forms.service";
import { HrFormsSubmissionsService } from "./hr-forms-submissions.service";
import {
  createHrFormSchema,
  listHrFormsQuerySchema,
  listSubmissionsQuerySchema,
  submitHrFormSchema,
  updateHrFormSchema,
  updateSubmissionStatusSchema,
  type CreateHrFormInput,
  type ListHrFormsQuery,
  type ListSubmissionsQuery,
  type SubmitHrFormInput,
  type UpdateHrFormInput,
  type UpdateSubmissionStatusInput,
} from "./dto/hr-forms.schemas";

@RequireModule("hr")
@Controller("hr/forms")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrFormsController {
  constructor(
    private readonly svc: HrFormsService,
    private readonly submissions: HrFormsSubmissionsService,
  ) {}

  @Get()
  @RequirePermission("hr:forms:view")
  list(
    @Query(new ZodValidationPipe(listHrFormsQuerySchema)) query: ListHrFormsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listForms(u.orgId, query);
  }

  @Get("submissions/my")
  @RequirePermission("hr:forms:view")
  mySubmissions(@CurrentUser() u: CurrentUserContext) {
    return this.submissions.getMySubmissions(u.orgId, u.userId);
  }

  @Get(":formId")
  @RequirePermission("hr:forms:view")
  get(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getForm(u.orgId, formId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:forms:manage")
  create(
    @Body(new ZodValidationPipe(createHrFormSchema)) body: CreateHrFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createForm(u.orgId, u.userId, body);
  }

  @Patch(":formId")
  @RequirePermission("hr:forms:manage")
  update(
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(updateHrFormSchema)) body: UpdateHrFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateForm(u.orgId, formId, body);
  }

  @Post(":formId/activate")
  @RequirePermission("hr:forms:manage")
  activate(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.activateForm(u.orgId, formId);
  }

  @Post(":formId/archive")
  @RequirePermission("hr:forms:manage")
  archive(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.archiveForm(u.orgId, formId);
  }

  @Delete(":formId")
  @HttpCode(204)
  @RequirePermission("hr:forms:manage")
  delete(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteForm(u.orgId, formId);
  }

  @Post(":formId/submissions")
  @HttpCode(201)
  @RequirePermission("hr:forms:view")
  submit(
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(submitHrFormSchema)) body: SubmitHrFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.submit(u.orgId, formId, body, u.userId, false);
  }

  @Get(":formId/submissions")
  @RequirePermission("hr:forms:view")
  listSubmissions(
    @Param("formId", ParseIntPipe) formId: number,
    @Query(new ZodValidationPipe(listSubmissionsQuerySchema)) query: ListSubmissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.listSubmissions(u.orgId, formId, query, false);
  }

  @Get(":formId/submissions/sensitive")
  @RequirePermission("hr:sensitive:view")
  listSubmissionsSensitive(
    @Param("formId", ParseIntPipe) formId: number,
    @Query(new ZodValidationPipe(listSubmissionsQuerySchema)) query: ListSubmissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.listSubmissions(u.orgId, formId, query, true);
  }

  @Patch("submissions/:submissionId/status")
  @RequirePermission("hr:forms:manage")
  updateStatus(
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body(new ZodValidationPipe(updateSubmissionStatusSchema)) body: UpdateSubmissionStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.updateSubmissionStatus(u.orgId, submissionId, body, u.userId);
  }
}
