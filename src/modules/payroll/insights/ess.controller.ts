import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EssService } from "./ess.service";
import {
  essBankSchema,
  type EssBank,
} from "./dto/insights.schemas";

@Controller("payroll/me")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EssController {
  constructor(private readonly essService: EssService) {}

  @Get("overview")
  @RequirePermission("self:payroll")
  getOverview(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getOverview(u.orgId, u.userId);
  }

  @Get("payslips")
  @RequirePermission("self:payslips")
  getPayslips(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getPayslips(u.orgId, u.userId);
  }

  @Get("salary-structure")
  @RequirePermission("self:payroll")
  getSalaryStructure(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getSalaryStructure(u.orgId, u.userId);
  }

  @Get("reimbursements")
  @RequirePermission("self:payroll")
  listReimbursements(@CurrentUser() u: CurrentUserContext) {
    return this.essService.listReimbursements(u.orgId, u.userId);
  }

  @Post("reimbursements")
  @RequirePermission("self:payroll")
  createReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { category: string; amount: number; description: string; receiptUrl?: string },
  ) {
    return this.essService.createReimbursement(u.orgId, u.userId, body);
  }

  @Get("loans")
  @RequirePermission("self:payroll")
  listLoans(@CurrentUser() u: CurrentUserContext) {
    return this.essService.listLoans(u.orgId, u.userId);
  }

  @Post("loans")
  @RequirePermission("self:payroll")
  createLoan(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { amount: number; reason: string; totalEmis: number },
  ) {
    return this.essService.createLoan(u.orgId, u.userId, body);
  }

  @Get("tax-declaration")
  @RequirePermission("self:payroll")
  getTaxDeclaration(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getTaxDeclaration(u.orgId, u.userId);
  }

  @Post("tax-declaration")
  @RequirePermission("self:payroll")
  submitTaxDeclaration(
    @CurrentUser() u: CurrentUserContext,
    @Body()
    body: {
      financialYear: string;
      regime: "OLD" | "NEW";
      hra?: number;
      lta?: number;
      section80c?: number;
      section80d?: number;
      section80g?: number;
      homeLoanInterest?: number;
    },
  ) {
    return this.essService.submitTaxDeclaration(u.orgId, u.userId, body);
  }

  @Post("tax-declaration/proofs")
  @RequirePermission("self:payroll")
  addTaxProof(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { declarationId: number; category: string; amount: number; description?: string; proofUrl?: string },
  ) {
    return this.essService.addTaxProof(u.orgId, u.userId, body);
  }

  @Get("bank")
  @RequirePermission("self:payroll")
  getBankDetails(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getBankDetails(u.orgId, u.userId);
  }

  @Patch("bank")
  @RequirePermission("self:payroll")
  updateBankDetails(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(essBankSchema)) body: EssBank,
  ) {
    return this.essService.updateBankDetails(u.orgId, u.userId, body);
  }

  @Get("fnf")
  @RequirePermission("self:payroll")
  getOwnFnf(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getOwnFnf(u.orgId, u.userId);
  }
}
