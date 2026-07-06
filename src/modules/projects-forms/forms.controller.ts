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
import { FormsService } from "./forms.service";
import {
  createFormSchema,
  listFormsQuerySchema,
  updateFormSchema,
  type CreateFormInput,
  type ListFormsQuery,
  type UpdateFormInput,
} from "./dto/forms.schemas";

@RequireModule("projects")
@Controller("projects/:projectId/forms")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FormsController {
  constructor(private readonly svc: FormsService) {}

  @Get()
  @RequirePermission("projects:forms:view")
  listForms(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listFormsQuerySchema)) query: ListFormsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listForms(u.orgId, projectId, query);
  }

  @Get(":formId")
  @RequirePermission("projects:forms:view")
  getForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getForm(u.orgId, projectId, formId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:forms:manage")
  createForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createFormSchema)) body: CreateFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createForm(u.orgId, u.userId, projectId, body);
  }

  @Patch(":formId")
  @RequirePermission("projects:forms:manage")
  updateForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(updateFormSchema)) body: UpdateFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateForm(u.orgId, u.userId, projectId, formId, body);
  }

  @Delete(":formId")
  @RequirePermission("projects:forms:manage")
  deleteForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteForm(u.orgId, u.userId, projectId, formId);
  }
}
