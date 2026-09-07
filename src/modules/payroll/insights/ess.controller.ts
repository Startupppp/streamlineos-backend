import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
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
import { listPageQuerySchema, type ListPageQueryInput } from "../hr-payroll/dto/payroll.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  essOverviewSchema,
  essPayslipsListSchema,
  essSalaryStructureSchema,
  essReimbursementsListSchema,
  essLoansListSchema,
  taxDeclarationResponseSchema,
  bankDetailsResponseSchema,
  updateBankResultSchema,
  ownFnfSchema,
  totalRewardsStatementSchema,
  reimbursementRowSchema,
  loanRowSchema,
  taxDeclarationRowSchema,
  investmentProofRowSchema,
} from "./dto/ess-response.schemas";

@Controller("payroll/me")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EssController {
  constructor(
    private readonly essService: EssService,
    private readonly essSelfService: EssSelfServiceService,
  ) {}

  @Get("overview")
  @RequirePermission("self:payroll")
  @ResponseSchema(essOverviewSchema)
  getOverview(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getOverview(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Get("payslips")
  @RequirePermission("self:payslips")
  @ResponseSchema(essPayslipsListSchema)
  getPayslips(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getPayslips(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Get("salary-structure")
  @RequirePermission("self:payroll")
  @ResponseSchema(essSalaryStructureSchema)
  getSalaryStructure(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getSalaryStructure(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Get("reimbursements")
  @RequirePermission("self:payroll")
  @Validate({ query: listPageQuerySchema })
  @ResponseSchema(essReimbursementsListSchema)
  listReimbursements(@CurrentUser() u: CurrentUserContext, @Query() query: ListPageQueryInput) {
    return this.essSelfService.listReimbursements(u.orgId, u.userId, actingMembershipId(u.principal), query.page, query.limit);
  }

  @Post("reimbursements")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essCreateReimbursementSchema })
  @ResponseSchema(reimbursementRowSchema)
  createReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssCreateReimbursement,
  ) {
    return this.essSelfService.createReimbursement(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Get("loans")
  @RequirePermission("self:payroll")
  @ResponseSchema(essLoansListSchema)
  listLoans(@CurrentUser() u: CurrentUserContext) {
    return this.essSelfService.listLoans(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Post("loans")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essCreateLoanSchema })
  @ResponseSchema(loanRowSchema)
  createLoan(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssCreateLoan,
  ) {
    return this.essSelfService.createLoan(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Get("tax-declaration")
  @RequirePermission("self:payroll")
  @ResponseSchema(taxDeclarationResponseSchema)
  getTaxDeclaration(@CurrentUser() u: CurrentUserContext) {
    return this.essSelfService.getTaxDeclaration(u.orgId, u.userId);
  }

  @Post("tax-declaration")
  @HttpCode(201)
  @RequirePermission("self:payroll")
  @Validate({ body: essSubmitTaxDeclarationSchema })
  @ResponseSchema(taxDeclarationRowSchema)
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
  @ResponseSchema(investmentProofRowSchema)
  addTaxProof(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssAddTaxProof,
  ) {
    return this.essSelfService.addTaxProof(u.orgId, u.userId, body);
  }

  @Get("bank")
  @RequirePermission("self:payroll")
  @ResponseSchema(bankDetailsResponseSchema)
  getBankDetails(@CurrentUser() u: CurrentUserContext) {
    return this.essSelfService.getBankDetails(u.orgId, u.userId);
  }

  @Patch("bank")
  @RequirePermission("self:payroll")
  @Validate({ body: essBankSchema })
  @ResponseSchema(updateBankResultSchema)
  updateBankDetails(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EssBank,
  ) {
    return this.essSelfService.updateBankDetails(u.orgId, u.userId, body);
  }

  @Get("fnf")
  @RequirePermission("self:payroll")
  @ResponseSchema(ownFnfSchema)
  getOwnFnf(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getOwnFnf(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  /** Illustrative total rewards (salary + benefits + equity units + leave). */
  @Get("total-rewards")
  @RequirePermission("self:payroll")
  @ResponseSchema(totalRewardsStatementSchema)
  getTotalRewards(@CurrentUser() u: CurrentUserContext) {
    return this.essService.getTotalRewards(u.orgId, u.userId, actingMembershipId(u.principal));
  }
}
