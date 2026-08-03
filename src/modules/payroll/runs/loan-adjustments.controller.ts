import {
  Controller,
  HttpCode,
  Post,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LoanAdjustmentsService } from "./loan-adjustments.service";
import { loanAdjustmentSchema, type LoanAdjustmentInput } from "./dto/runs.schemas";

@RequireModule("payroll")
@Controller("payroll/runs/:runId/loan-adjustments")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class LoanAdjustmentsController {
  constructor(private readonly loanAdjustmentsService: LoanAdjustmentsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:runs:update")
  async create(
    @Param("runId", ParseIntPipe) runId: number,
    @Body(new ZodValidationPipe(loanAdjustmentSchema)) body: LoanAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.loanAdjustmentsService.createAdjustment(u.orgId, runId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Payroll run not found");
      if (result.reason === "loan_not_found") throw new NotFoundException("Loan not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot modify a locked run");
      if (result.reason === "loan_not_active") throw new BadRequestException("Loan is not in ACTIVE status");
      throw new BadRequestException(result.reason);
    }
    return { id: result.id };
  }
}
