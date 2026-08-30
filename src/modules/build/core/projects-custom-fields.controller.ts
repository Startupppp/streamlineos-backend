import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  upsertCustomFieldValuesSchema,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
  type UpsertCustomFieldValuesInput,
} from "./dto/custom-fields.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdfieldIdParams = z.object({ projectId: z.string().min(1), fieldId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsCustomFieldsController {
  constructor(private readonly customFields: ProjectsCustomFieldsService) {}

  @Get(":projectId/custom-fields")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  listFields(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.listFields(u.orgId, projectId);
  }

  @Post(":projectId/custom-fields")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Validate({ params: projectIdParams })
  createField(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createCustomFieldSchema)) body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.createField(u.orgId, projectId, body);
  }

  @Patch(":projectId/custom-fields/:fieldId")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdfieldIdParams })
  updateField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body(new ZodValidationPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.updateField(u.orgId, fieldId, body);
  }

  @Delete(":projectId/custom-fields/:fieldId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: projectIdfieldIdParams })
  deleteField(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.deleteField(u.orgId, fieldId);
  }

  @Get(":projectId/tickets/:ticketId/custom-field-values")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdticketIdParams })
  getTicketValues(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.getTicketValues(u.orgId, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/custom-field-values")
  @RequirePermission("build:tickets:update")
  @HttpCode(200)
  @Validate({ params: projectIdticketIdParams })
  upsertTicketValues(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(upsertCustomFieldValuesSchema)) body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.upsertTicketValues(u.orgId, projectId, ticketId, body);
  }
}
