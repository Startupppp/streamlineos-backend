import { Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ExpensesImportService } from "./expenses-import.service";
import { importSchema, type ImportInput } from "./dto/expense-import.schemas";

function canApprove(u: CurrentUserContext): boolean {
  return u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:expenses:approve");
}

@Controller("hr/expenses/import")
@UseGuards(JwtAuthGuard)
export class ExpensesImportController {
  constructor(private readonly importer: ExpensesImportService) {}

  @Post()
  @HttpCode(200)
  importExpenses(
    @Body(new ZodValidationPipe(importSchema)) body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canApprove(u)) {
      throw new ForbiddenException("Only HR and CEO can import expenses");
    }
    return this.importer.importExpenses(u.orgId, u.userId, body);
  }
}
