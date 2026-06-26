import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PayrollsService } from "./payrolls.service";
import { renderPayslipHtml } from "./lib/payslip-html";
import {
  allPayrollsQuerySchema,
  generatePayrollSchema,
  generateSinglePayrollSchema,
  type AllPayrollsQueryInput,
  type GeneratePayrollInput,
  type GenerateSinglePayrollInput,
} from "./dto/payroll.schemas";

@Controller("hr/payrolls")
@UseGuards(JwtAuthGuard)
export class PayrollsController {
  constructor(private readonly payrolls: PayrollsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.payrolls.getPayrolls(u.orgId, u.userId);
  }

  @Get("all")
  @UseGuards(ModuleGuard, AbilityGuard)
  @RequireModule("hr")
  @CheckAbility("view", "hr:payroll")
  listAll(
    @Query(new ZodValidationPipe(allPayrollsQuerySchema)) query: AllPayrollsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!query.month && !query.year) {
      throw new BadRequestException("Either month (YYYY-MM) or year (YYYY) query param is required.");
    }
    return this.payrolls.getAllPayrolls(u.orgId, { month: query.month, year: query.year });
  }

  @Post()
  async generateBulk(
    @Body(new ZodValidationPipe(generatePayrollSchema)) body: GeneratePayrollInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ability = defineAbilityFor({
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
    });
    if (!ability.can("generate", "hr:payroll")) {
      throw new ForbiddenException("Only admins can generate payroll.");
    }

    if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
      throw new BadRequestException("month is required in YYYY-MM format.");
    }

    const result = await this.payrolls.generateBulk(u.orgId, u.userId, body.month);
    res.status(result.hadMembers ? 201 : 200);
    return { generated: result.generated };
  }

  @Post("generate")
  @UseGuards(ModuleGuard, AbilityGuard)
  @RequireModule("hr")
  @CheckAbility("generate", "hr:payroll")
  @HttpCode(201)
  async generateSingle(
    @Body(new ZodValidationPipe(generateSinglePayrollSchema)) body: GenerateSinglePayrollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.payrolls.generateSingle(u.orgId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "no_salary_structure") {
        throw new BadRequestException("No active salary structure found for this employee.");
      }
      throw new ConflictException(`Payroll for this employee and month (${result.month}) already exists.`);
    }
    return { success: true };
  }

  @Get(":payrollId/download")
  async download(
    @Param("payrollId", ParseIntPipe) payrollId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const ability = defineAbilityFor({
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
    });
    const isAdmin = ability.can("approve", "hr:payroll") || ability.can("generate", "hr:payroll");

    const result = await this.payrolls.getPayslipDownload(u.orgId, payrollId, u.userId, isAdmin);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Payroll not found.");
      if (result.reason === "not_paid") throw new BadRequestException("Payslip only available for PAID payrolls.");
      throw new ForbiddenException("Access denied.");
    }

    const { html, fileName } = await renderPayslipHtml(result.payroll, result.employee, result.org);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.send(html);
  }
}
