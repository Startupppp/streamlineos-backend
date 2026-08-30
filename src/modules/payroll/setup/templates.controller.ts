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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/templates")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollTemplatesController {
  constructor(private readonly service: PayrollTemplatesService) {}

  @Get()
  @RequirePermission("payroll:templates:view")
  async list(
    @Query(new ZodValidationPipe(listTemplatesSchema)) query: ListTemplatesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.list(u.orgId, query);
  }

  @Get(":templateId")
  @RequirePermission("payroll:templates:view")
  @Validate({ params: templateIdParams })
  async getById(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.getById(u.orgId, templateId);
  }

  @Post(":templateId/duplicate")
  @HttpCode(201)
  @RequirePermission("payroll:templates:manage")
  @Validate({ params: templateIdParams })
  async duplicate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(duplicateTemplateSchema)) body: DuplicateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.duplicate(u.orgId, templateId, body);
  }

  @Post(":templateId/preview")
  @RequirePermission("payroll:templates:view")
  @Validate({ params: templateIdParams })
  async preview(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(templatePreviewSchema)) body: TemplatePreviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.preview(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  @RequirePermission("payroll:templates:manage")
  @Validate({ params: templateIdParams })
  async deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.deleteCustomTemplate(u.orgId, templateId);
  }
}
