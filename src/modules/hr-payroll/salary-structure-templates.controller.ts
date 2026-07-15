import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SalaryStructureTemplatesService } from "./salary-structure-templates.service";
import {
  createSalaryStructureTemplateSchema,
  updateSalaryStructureTemplateSchema,
  type CreateSalaryStructureTemplateInput,
  type UpdateSalaryStructureTemplateInput,
} from "./dto/payroll.schemas";

@UseGuards(JwtAuthGuard)
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
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createSalaryStructureTemplateSchema)) body: CreateSalaryStructureTemplateInput,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSalaryStructureTemplateSchema)) body: UpdateSalaryStructureTemplateInput,
  ) {
    return this.service.update(u.orgId, id, body);
  }

  @Delete(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.remove(u.orgId, id);
  }
}
