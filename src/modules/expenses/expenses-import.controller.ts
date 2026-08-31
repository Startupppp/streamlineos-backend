import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ExpensesImportService } from "./expenses-import.service";
import { importSchema, type ImportInput } from "./dto/expense-import.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("hr/expenses/import")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExpensesImportController {
  constructor(private readonly importer: ExpensesImportService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission("hr:expenses:manage")
  @Validate({ body: importSchema })
  importExpenses(
    @Body() body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.importer.importExpenses(u.orgId, u.userId, body);
  }
}
