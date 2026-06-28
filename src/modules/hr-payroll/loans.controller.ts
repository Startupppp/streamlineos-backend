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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { LoansService } from "./loans.service";
import {
  createLoanSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type UpdateLoanInput,
} from "./dto/payroll.schemas";

@Controller("hr/loans")
@UseGuards(JwtAuthGuard)
export class LoansController {
  constructor(
    private readonly loans: LoansService,
    private readonly access: AccessService,
  ) {}

  private async isLoanAdmin(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner || u.isPlatformAdmin) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:expenses:approve");
  }

  @Get()
  async list(@CurrentUser() u: CurrentUserContext) {
    return this.loans.listLoans(u.orgId, u.userId, await this.isLoanAdmin(u));
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createLoanSchema)) body: CreateLoanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.loans.createLoan(u.orgId, u.userId, await this.isLoanAdmin(u), body);
  }

  @Patch(":loanId")
  async update(
    @Param("loanId", ParseIntPipe) loanId: number,
    @Body(new ZodValidationPipe(updateLoanSchema)) body: UpdateLoanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!(await this.isLoanAdmin(u))) throw new ForbiddenException("Only admins can manage loans.");

    const result = await this.loans.updateLoan(u.orgId, u.userId, loanId, body);
    if (!result.ok) throw new NotFoundException("Loan not found.");
    return { success: true };
  }
}
