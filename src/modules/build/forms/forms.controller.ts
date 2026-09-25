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
import { FormsService } from "./forms.service";
import {
  createFormSchema,
  listFormsQuerySchema,
  updateFormSchema,
  type CreateFormInput,
  type ListFormsQuery,
  type UpdateFormInput,
} from "./dto/forms.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { formPageSchema, formRowSchema } from "./dto/forms-response.schemas";

export const formIdParams = z.object({ projectId: z.coerce.number().int().positive(), formId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/forms")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FormsController {
  constructor(private readonly svc: FormsService) {}

  @Get()
  @RequirePermission("build:forms:view")
  @ResponseSchema(formPageSchema)
  @Validate({ query: listFormsQuerySchema })
  listForms(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListFormsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listForms(u, projectId, query);
  }

  @Get(":formId")
  @RequirePermission("build:forms:view")
  @ResponseSchema(formRowSchema)
  @Validate({ params: formIdParams })
  getForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getForm(u, projectId, formId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:forms:manage")
  @ResponseSchema(formRowSchema)
  @Validate({ body: createFormSchema })
  createForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createForm(u, projectId, body);
  }

  @Patch(":formId")
  @RequirePermission("build:forms:manage")
  @ResponseSchema(formRowSchema)
  @Validate({ params: formIdParams, body: updateFormSchema })
  updateForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Body() body: UpdateFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateForm(u, projectId, formId, body);
  }

  @Delete(":formId")
  @RequirePermission("build:forms:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: formIdParams })
  deleteForm(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteForm(u, projectId, formId);
  }
}
