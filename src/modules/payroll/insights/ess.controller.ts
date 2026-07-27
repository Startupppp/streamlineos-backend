import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EssService } from "./ess.service";
import {
  essBankSchema,
  essCreateReimbursementSchema,
  essCreateLoanSchema,
  essSubmitTaxDeclarationSchema,
  essAddTaxProofSchema,
  type EssBank,
  type EssCreateReimbursement,
  type EssCreateLoan,
  type EssSubmitTaxDeclaration,
  type EssAddTaxProof,
} from "./dto/insights.schemas";

@RequireModule("payroll")
@Controller("payroll/me")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
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
  @HttpCode(201)
  @RequirePermission("self:payroll")
  createReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(essCreateReimbursementSchema)) body: EssCreateReimbursement,
  ) {
    return this.essService.createReimbursement(u.orgId, u.userId, body);
  }

  @Get("loans")
  @RequirePermission("self:payroll")
  listLoans(@CurrentUser() u: CurrentUserContext) {
    return this.essService.listLoans(u.orgId, u.userId);
  }

  @Post("loans")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  createLoan(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(essCreateLoanSchema)) body: EssCreateLoan,
  ) {
    return this.essService.createLoan(u.orgId, u.userId, body);
  }

  @Get("tax-declaration")
  @RequirePermission("self:payroll")
  getTaxDeclaration(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getTaxDeclaration(u.orgId, u.userId);
  }

  @Post("tax-declaration")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  submitTaxDeclaration(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(essSubmitTaxDeclarationSchema)) body: EssSubmitTaxDeclaration,
  ) {
    return this.essService.submitTaxDeclaration(u.orgId, u.userId, body);
  }

  @Post("tax-declaration/proofs")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  addTaxProof(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(essAddTaxProofSchema)) body: EssAddTaxProof,
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

  /** Illustrative total rewards (salary + benefits + equity units + leave). */
  @Get("total-rewards")
  @RequirePermission("self:payroll")
  getTotalRewards(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getTotalRewards(u.orgId, u.userId);
  }
}
