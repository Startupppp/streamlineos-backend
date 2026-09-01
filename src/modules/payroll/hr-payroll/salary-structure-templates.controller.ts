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
import { SalaryStructureTemplatesService } from "./salary-structure-templates.service";
import {
  createSalaryStructureTemplateSchema,
  updateSalaryStructureTemplateSchema,
  cursorListQuerySchema,
  type CreateSalaryStructureTemplateInput,
  type UpdateSalaryStructureTemplateInput,
  type CursorListQueryInput,
} from "./dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@UseGuards(JwtAuthGuard, ModuleGuard)
@Controller("hr/payroll/salary-structures")
export class SalaryStructureTemplatesController {
  constructor(private readonly service: SalaryStructureTemplatesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:view")
  @Validate({ query: cursorListQuerySchema })
  list(@CurrentUser() u: CurrentUserContext, @Query() query: CursorListQueryInput) {
    return this.service.list(u.orgId, query.cursor, query.limit);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  @Validate({ body: createSalaryStructureTemplateSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateSalaryStructureTemplateInput,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  @Validate({ params: templateIdParams, body: updateSalaryStructureTemplateSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: UpdateSalaryStructureTemplateInput,
  ) {
    return this.service.update(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  @Validate({ params: templateIdParams })
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("templateId", ParseIntPipe) templateId: number,
  ) {
    return this.service.remove(u.orgId, templateId);
  }
}
