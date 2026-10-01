import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  upsertCustomFieldValuesSchema,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
  type UpsertCustomFieldValuesInput,
} from "../dto/custom-fields.schemas";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../../common/openapi/response-envelopes";
import {
  buildCustomFieldSchema,
  ticketFieldValueSchema,
} from "../dto/build-core-response.schemas";
import { projectAndTicketIdParams } from "../dto/build-params.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdfieldIdParams = z.object({ projectId: z.string().min(1), fieldId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsCustomFieldsController {
  constructor(private readonly customFields: ProjectsCustomFieldsService) {}

  @Get(":projectId/custom-fields")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(buildCustomFieldSchema))
  @Validate({ params: projectIdParams })
  listFields(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.listFields(u, projectId);
  }

  @Post(":projectId/custom-fields")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @ResponseSchema(buildCustomFieldSchema)
  @Validate({ params: projectIdParams, body: createCustomFieldSchema })
  createField(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.createField(u, projectId, body);
  }

  @Patch(":projectId/custom-fields/:fieldId")
  @RequirePermission("build:manage")
  @ResponseSchema(buildCustomFieldSchema)
  @Validate({ params: projectIdfieldIdParams, body: updateCustomFieldSchema })
  updateField(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateCustomFieldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.updateField(u, projectId, fieldId, body);
  }

  @Delete(":projectId/custom-fields/:fieldId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdfieldIdParams })
  deleteField(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.deleteField(u, projectId, fieldId);
  }

  @Get(":projectId/tickets/:ticketId/custom-field-values")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(ticketFieldValueSchema))
  @Validate({ params: projectAndTicketIdParams })
  getTicketValues(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.getTicketValues(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/custom-field-values")
  @RequirePermission("build:tickets:update")
  @HttpCode(200)
  @ResponseSchema(successSchema)
  @Validate({ params: projectAndTicketIdParams, body: upsertCustomFieldValuesSchema })
  upsertTicketValues(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: UpsertCustomFieldValuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customFields.upsertTicketValues(u, projectId, ticketId, body);
  }
}
