import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ImportsService } from "./imports.service";
import {
  bankImportsQuerySchema,
  createBankImportSchema,
  type BankImportsQuery,
  type CreateBankImportInput,
} from "./dto/imports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("finance/bank-imports")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ImportsController {
  constructor(private readonly service: ImportsService) {}

  @Get()
  @RequirePermission("accounting:banking:read")
  @Validate({ query: bankImportsQuerySchema })
  list(
    @Query() query: BankImportsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listImports(u, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:banking:import")
  @Validate({ body: createBankImportSchema })
  create(
    @Body() body: CreateBankImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createImport(u, body);
  }
}
