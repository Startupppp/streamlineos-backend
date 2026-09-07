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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  hrFormListSchema,
  hrFormRowSchema,
  hrFormSubmissionListSchema,
  hrFormSubmissionRowSchema,
} from "./dto/forms-response.schemas";

const formIdParams = z.object({ formId: z.coerce.number().int().positive() }).strict();
const submissionIdParams = z.object({ submissionId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/forms")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrFormsController {
  constructor(
    private readonly svc: HrFormsService,
    private readonly submissions: HrFormsSubmissionsService,
  ) {}

  @Get()
  @ResponseSchema(hrFormListSchema)
  @RequirePermission("hr:forms:view")
  @Validate({ query: listHrFormsQuerySchema })
  list(
    @Query() query: ListHrFormsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listForms(u.orgId, query);
  }

  @Get("submissions/my")
  @ResponseSchema(z.array(hrFormSubmissionRowSchema))
  @RequirePermission("hr:forms:view")
  mySubmissions(@CurrentUser() u: CurrentUserContext) {
    return this.submissions.getMySubmissions(u.orgId, u.userId);
  }

  @Get(":formId")
  @ResponseSchema(hrFormRowSchema)
  @RequirePermission("hr:forms:view")
  @Validate({ params: formIdParams })
  get(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getForm(u.orgId, formId);
  }

  @Post()
  @ResponseSchema(hrFormRowSchema)
  @HttpCode(201)
  @RequirePermission("hr:forms:manage")
  @Validate({ body: createHrFormSchema })
  create(
    @Body() body: CreateHrFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createForm(u.orgId, u.userId, body);
  }

  @Patch(":formId")
  @ResponseSchema(hrFormRowSchema)
  @RequirePermission("hr:forms:manage")
  @Validate({ params: formIdParams, body: updateHrFormSchema })
  update(
    @Param("formId", ParseIntPipe) formId: number,
    @Body() body: UpdateHrFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateForm(u.orgId, formId, body);
  }

  @Post(":formId/activate")
  @ResponseSchema(hrFormRowSchema)
  @BodylessAction()
  @RequirePermission("hr:forms:manage")
  @Validate({ params: formIdParams })
  activate(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.activateForm(u.orgId, formId);
  }

  @Post(":formId/archive")
  @ResponseSchema(hrFormRowSchema)
  @BodylessAction()
  @RequirePermission("hr:forms:manage")
  @Validate({ params: formIdParams })
  archive(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.archiveForm(u.orgId, formId);
  }

  @Delete(":formId")
  @NoContentResponse()
  @HttpCode(204)
  @RequirePermission("hr:forms:manage")
  @Validate({ params: formIdParams })
  delete(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteForm(u.orgId, formId);
  }

  @Post(":formId/submissions")
  @ResponseSchema(hrFormSubmissionRowSchema)
  @HttpCode(201)
  @RequirePermission("hr:forms:view")
  @Validate({ params: formIdParams, body: submitHrFormSchema })
  submit(
    @Param("formId", ParseIntPipe) formId: number,
    @Body() body: SubmitHrFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.submit(u.orgId, formId, body, u.userId, false);
  }

  @Get(":formId/submissions")
  @ResponseSchema(hrFormSubmissionListSchema)
  @RequirePermission("hr:forms:view")
  @Validate({ params: formIdParams, query: listSubmissionsQuerySchema })
  listSubmissions(
    @Param("formId", ParseIntPipe) formId: number,
    @Query() query: ListSubmissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.listSubmissions(u.orgId, formId, query, false);
  }

  @Get(":formId/submissions/sensitive")
  @ResponseSchema(hrFormSubmissionListSchema)
  @RequirePermission("hr:sensitive:view")
  @Validate({ params: formIdParams, query: listSubmissionsQuerySchema })
  listSubmissionsSensitive(
    @Param("formId", ParseIntPipe) formId: number,
    @Query() query: ListSubmissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.listSubmissions(u.orgId, formId, query, true);
  }

  @Patch("submissions/:submissionId/status")
  @ResponseSchema(hrFormSubmissionRowSchema)
  @RequirePermission("hr:forms:manage")
  @Validate({ params: submissionIdParams, body: updateSubmissionStatusSchema })
  updateStatus(
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() body: UpdateSubmissionStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.submissions.updateSubmissionStatus(u.orgId, submissionId, body, u.userId);
  }
}
