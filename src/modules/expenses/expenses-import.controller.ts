import { Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { ExpensesImportService } from "./expenses-import.service";
import { importSchema, type ImportInput } from "./dto/expense-import.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("accounting")
@Controller("hr/expenses/import")
@UseGuards(JwtAuthGuard)
export class ExpensesImportController {
  constructor(
    private readonly importer: ExpensesImportService,
    private readonly access: AccessService,
  ) {}

  @Post()
  @HttpCode(200)
  async importExpenses(
    @Body(new ZodValidationPipe(importSchema)) body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:expenses:approve")) {
        throw new ForbiddenException("Only HR and CEO can import expenses");
      }
    }
    return this.importer.importExpenses(u.orgId, u.userId, body);
  }
}
