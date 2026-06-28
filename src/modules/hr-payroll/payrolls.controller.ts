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
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
<<<<<<< HEAD
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
=======
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { requireAuthorize } from "../../common/access/authorize";
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { PayrollsService } from "./payrolls.service";
import { PayrollStatusService } from "./payrolls-status.service";
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
  constructor(
    private readonly payrolls: PayrollsService,
    private readonly payrollStatus: PayrollStatusService,
    private readonly access: AccessService,
  ) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.payrolls.getPayrolls(u.orgId, u.userId);
  }

  @Get("all")
<<<<<<< HEAD
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:payroll:view")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  listAll(
    @Query(new ZodValidationPipe(allPayrollsQuerySchema)) query: AllPayrollsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:view", requiredModule: "hr" });
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
<<<<<<< HEAD
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:payroll:generate")) {
        throw new ForbiddenException("Only admins can generate payroll.");
      }
    }

=======
    requireAuthorize(u, { permission: "hr:payroll:manage", requiredModule: "hr" });
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
    if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
      throw new BadRequestException("month is required in YYYY-MM format.");
    }

    const result = await this.payrolls.generateBulk(u.orgId, u.userId, body.month);
    res.status(result.hadMembers ? 201 : 200);
    return { generated: result.generated };
  }

  @Post("generate")
<<<<<<< HEAD
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:payroll:generate")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  @HttpCode(201)
  async generateSingle(
    @Body(new ZodValidationPipe(generateSinglePayrollSchema)) body: GenerateSinglePayrollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:manage", requiredModule: "hr" });
    const result = await this.payrolls.generateSingle(u.orgId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "no_salary_structure") {
        throw new BadRequestException("No active salary structure found for this employee.");
      }
      throw new ConflictException(`Payroll for this employee and month (${result.month}) already exists.`);
    }
    return { success: true };
  }

  @Patch(":payrollId/approve")
<<<<<<< HEAD
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:payroll:approve")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  async approve(
    @Param("payrollId", ParseIntPipe) payrollId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:manage", requiredModule: "hr" });
    const result = await this.payrollStatus.approve(u.orgId, u.userId, payrollId);
    if (!result.ok) throw new NotFoundException("Payroll not found.");
    return { success: true };
  }

  @Patch(":payrollId/paid")
<<<<<<< HEAD
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:payrolls:manage")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  async markPaid(
    @Param("payrollId", ParseIntPipe) payrollId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:manage", requiredModule: "hr" });
    const result = await this.payrollStatus.markPaid(u.orgId, u.userId, payrollId);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Payroll not found.");
      throw new BadRequestException("Payroll must be approved before marking as paid.");
    }
    return { success: true };
  }

  @Get(":payrollId/download")
  async download(
    @Param("payrollId", ParseIntPipe) payrollId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
<<<<<<< HEAD
    let isAdmin = u.isOrgOwner || u.isPlatformAdmin;
    if (!isAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      isAdmin = perms.has("hr:payroll:approve") || perms.has("hr:payroll:generate");
    }
=======
    const isAdmin = u.isPlatformAdmin || u.isOrgOwner || (u.permissions ?? []).includes("hr:payroll:manage");
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8

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
