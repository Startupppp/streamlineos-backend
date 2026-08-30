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
  Query,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { LoansService } from "./loans.service";
import {
  createLoanSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type UpdateLoanInput,
  listPageQuerySchema,
  type ListPageQueryInput,
} from "./dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const loanIdParams = z.object({ loanId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("hr/loans")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class LoansController {
  constructor(
    private readonly loans: LoansService,
    private readonly access: AccessService,
  ) {}

  private async isLoanAdmin(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:expenses:approve");
  }

  @Get()
  @RequirePermission("hr:payroll:view")
  @Validate({ query: listPageQuerySchema })
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListPageQueryInput,
  ) {
    return this.loans.listLoans(u.orgId, u.userId, await this.isLoanAdmin(u), query.page ?? 1, query.limit ?? 100);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:payroll:view")
  @Validate({ body: createLoanSchema })
  async create(
    @Body() body: CreateLoanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.loans.createLoan(u.orgId, u.userId, await this.isLoanAdmin(u), body);
  }

  @Patch(":loanId")
  @RequirePermission("hr:payroll:view")
  @Validate({ params: loanIdParams, body: updateLoanSchema })
  async update(
    @Param("loanId", ParseIntPipe) loanId: number,
    @Body() body: UpdateLoanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!(await this.isLoanAdmin(u))) {
      throw new ForbiddenException("Only admins can process loan status changes.");
    }
    const result = await this.loans.updateLoan(u.orgId, u.userId, loanId, body);
    if (!result.ok) throw new NotFoundException("Loan not found.");
    return { success: true };
  }
}
