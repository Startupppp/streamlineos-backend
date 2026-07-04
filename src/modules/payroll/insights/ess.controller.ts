import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { CurrentUserContext } from "../../../common/auth/backend-claims";
import { BankDetails } from "../../onboarding/crypto.helpers";
import { EssService } from "./ess.service";

@Controller("payroll/me")
@UseGuards(JwtAuthGuard)
export class EssController {
  constructor(private readonly essService: EssService) {}

  @Get("overview")
  getOverview(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getOverview(u.orgId, u.userId);
  }

  @Get("payslips")
  getPayslips(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getPayslips(u.orgId, u.userId);
  }

  @Get("salary-structure")
  getSalaryStructure(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getSalaryStructure(u.orgId, u.userId);
  }

  @Get("reimbursements")
  listReimbursements(@CurrentUser() u: CurrentUserContext) {
    return this.essService.listReimbursements(u.orgId, u.userId);
  }

  @Post("reimbursements")
  createReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { category: string; amount: number; description: string; receiptUrl?: string },
  ) {
    return this.essService.createReimbursement(u.orgId, u.userId, body);
  }

  @Get("loans")
  listLoans(@CurrentUser() u: CurrentUserContext) {
    return this.essService.listLoans(u.orgId, u.userId);
  }

  @Post("loans")
  createLoan(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { amount: number; reason: string; totalEmis: number },
  ) {
    return this.essService.createLoan(u.orgId, u.userId, body);
  }

  @Get("tax-declaration")
  getTaxDeclaration(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getTaxDeclaration(u.orgId, u.userId);
  }

  @Post("tax-declaration")
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
  addTaxProof(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: { declarationId: number; category: string; amount: number; description?: string; proofUrl?: string },
  ) {
    return this.essService.addTaxProof(u.orgId, u.userId, body);
  }

  @Get("bank")
  getBankDetails(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getBankDetails(u.orgId, u.userId);
  }

  @Patch("bank")
  updateBankDetails(@CurrentUser() u: CurrentUserContext, @Body() body: BankDetails) {
    return this.essService.updateBankDetails(u.orgId, u.userId, body);
  }

  @Get("fnf")
  getOwnFnf(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getOwnFnf(u.orgId, u.userId);
  }
}
