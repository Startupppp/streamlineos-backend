import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollTemplatesService } from "./templates.service";
import {
  listTemplatesSchema,
  templatePreviewSchema,
  duplicateTemplateSchema,
  type ListTemplatesInput,
  type TemplatePreviewInput,
  type DuplicateTemplateInput,
} from "./dto/setup.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  payrollTemplateRowSchema,
  templateListResponseSchema,
  templatePreviewResponseSchema,
} from "./dto/templates-response.schemas";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/templates")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollTemplatesController {
  constructor(private readonly service: PayrollTemplatesService) {}

  @Get()
  @RequirePermission("payroll:templates:view")
  @Validate({ query: listTemplatesSchema })
  @ResponseSchema(templateListResponseSchema)
  async list(
    @Query() query: ListTemplatesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.list(u.orgId, query);
  }

  @Get(":templateId")
  @RequirePermission("payroll:templates:view")
  @Validate({ params: templateIdParams })
  @ResponseSchema(payrollTemplateRowSchema)
  async getById(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.getById(u.orgId, templateId);
  }

  @Post(":templateId/duplicate")
  @HttpCode(201)
  @RequirePermission("payroll:templates:manage")
  @Validate({ params: templateIdParams, body: duplicateTemplateSchema })
  @ResponseSchema(payrollTemplateRowSchema)
  async duplicate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: DuplicateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.duplicate(u.orgId, templateId, body);
  }

  @Post(":templateId/preview")
  @RequirePermission("payroll:templates:view")
  @Validate({ params: templateIdParams, body: templatePreviewSchema })
  @ResponseSchema(templatePreviewResponseSchema)
  async preview(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: TemplatePreviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.preview(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  @RequirePermission("payroll:templates:manage")
  @Validate({ params: templateIdParams })
  @NoContentResponse()
  async deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.deleteCustomTemplate(u.orgId, templateId);
  }
}
