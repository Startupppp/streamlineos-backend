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
import { PayslipTemplatesService } from "./payslip-templates.service";
import {
  createTemplateSchema,
  patchTemplateSchema,
  previewTemplateSchema,
  type CreateTemplateInput,
  type PatchTemplateInput,
  type PreviewTemplateInput,
} from "./dto/payout.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/payslip-templates")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayslipTemplatesController {
  constructor(private readonly templates: PayslipTemplatesService) {}

  @Get()
  @RequirePermission("payroll:payslips:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.templates.list(u.orgId);
  }

  @Post("preview")
  @HttpCode(200)
  @RequirePermission("payroll:payslips:manage")
  preview(
    @Body(new ZodValidationPipe(previewTemplateSchema)) body: PreviewTemplateInput,
  ) {
    return { html: this.templates.preview(body) };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:payslips:manage")
  create(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.create(u.orgId, body);
  }

  @Patch(":templateId")
  @RequirePermission("payroll:payslips:manage")
  @Validate({ params: templateIdParams })
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(patchTemplateSchema)) body: PatchTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  @RequirePermission("payroll:payslips:manage")
  @Validate({ params: templateIdParams })
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.delete(u.orgId, templateId);
  }
}
