import {
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
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
import { SalaryStructureTemplatesService } from "./salary-structure-templates.service";
import {
  createSalaryStructureTemplateSchema,
  updateSalaryStructureTemplateSchema,
  type CreateSalaryStructureTemplateInput,
  type UpdateSalaryStructureTemplateInput,
} from "./dto/payroll.schemas";

@RequireModule("payroll")
@UseGuards(JwtAuthGuard, ModuleGuard)
@Controller("hr/payroll/salary-structures")
export class SalaryStructureTemplatesController {
  constructor(private readonly service: SalaryStructureTemplatesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createSalaryStructureTemplateSchema)) body: CreateSalaryStructureTemplateInput,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateSalaryStructureTemplateSchema)) body: UpdateSalaryStructureTemplateInput,
  ) {
    return this.service.update(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("templateId", ParseIntPipe) templateId: number,
  ) {
    return this.service.remove(u.orgId, templateId);
  }
}
