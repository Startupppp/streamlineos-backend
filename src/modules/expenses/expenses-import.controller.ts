import { Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ExpensesImportService } from "./expenses-import.service";
import { importSchema, type ImportInput } from "./dto/expense-import.schemas";

function canApprove(u: CurrentUserContext): boolean {
  const ability = defineAbilityFor({
    isPlatformAdmin: u.isPlatformAdmin,
    isOrgOwner: u.isOrgOwner,
    permissions: u.permissions,
    enabledModules: u.enabledModules,
  });
  return ability.can("approve", "hr:expenses");
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
