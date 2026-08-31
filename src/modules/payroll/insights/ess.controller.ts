import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { EssService } from "./ess.service";
import { EssSelfServiceService } from "./ess-self-service.service";
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

@Controller("payroll/me")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EssController {
  constructor(
    private readonly essService: EssService,
    private readonly essSelfService: EssSelfServiceService,
  ) {}

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
    return this.essSelfService.listReimbursements(u.orgId, u.userId);
  }

  @Post("reimbursements")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essCreateReimbursementSchema })
  createReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssCreateReimbursement,
  ) {
    return this.essSelfService.createReimbursement(u.orgId, u.userId, body);
  }

  @Get("loans")
  @RequirePermission("self:payroll")
  listLoans(@CurrentUser() u: CurrentUserContext) {
    return this.essSelfService.listLoans(u.orgId, u.userId);
  }

  @Post("loans")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essCreateLoanSchema })
  createLoan(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssCreateLoan,
  ) {
    return this.essSelfService.createLoan(u.orgId, u.userId, body);
  }

  @Get("tax-declaration")
  @RequirePermission("self:payroll")
  getTaxDeclaration(@CurrentUser() u: CurrentUserContext) {
    return this.essSelfService.getTaxDeclaration(u.orgId, u.userId);
  }

  @Post("tax-declaration")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essSubmitTaxDeclarationSchema })
  submitTaxDeclaration(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssSubmitTaxDeclaration,
  ) {
    return this.essSelfService.submitTaxDeclaration(u.orgId, u.userId, body);
  }

  @Post("tax-declaration/proofs")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essAddTaxProofSchema })
  addTaxProof(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssAddTaxProof,
  ) {
    return this.essSelfService.addTaxProof(u.orgId, u.userId, body);
  }

  @Get("bank")
  @RequirePermission("self:payroll")
  getBankDetails(@CurrentUser() u: CurrentUserContext) {
    return this.essSelfService.getBankDetails(u.orgId, u.userId);
  }

  @Patch("bank")
  @RequirePermission("self:payroll")
  @Validate({ body: essBankSchema })
  updateBankDetails(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssBank,
  ) {
    return this.essSelfService.updateBankDetails(u.orgId, u.userId, body);
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
