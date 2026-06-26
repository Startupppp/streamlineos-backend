import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { LoansService } from "./loans.service";
import {
  createLoanSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type UpdateLoanInput,
} from "./dto/payroll.schemas";

function isLoanAdmin(u: CurrentUserContext): boolean {
  const ability = defineAbilityFor({
    isPlatformAdmin: u.isPlatformAdmin,
    isOrgOwner: u.isOrgOwner,
    permissions: u.permissions,
    enabledModules: u.enabledModules,
  });
  return ability.can("approve", "hr:expenses");
}

@Controller("hr/loans")
@UseGuards(JwtAuthGuard)
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.loans.listLoans(u.orgId, u.userId, isLoanAdmin(u));
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createLoanSchema)) body: CreateLoanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.loans.createLoan(u.orgId, u.userId, isLoanAdmin(u), body);
  }

  @Patch(":loanId")
  async update(
    @Param("loanId", ParseIntPipe) loanId: number,
    @Body(new ZodValidationPipe(updateLoanSchema)) body: UpdateLoanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!isLoanAdmin(u)) throw new ForbiddenException("Only admins can manage loans.");

    const result = await this.loans.updateLoan(u.orgId, u.userId, loanId, body);
    if (!result.ok) throw new NotFoundException("Loan not found.");
    return { success: true };
  }
}
