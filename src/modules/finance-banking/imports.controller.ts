import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ImportsService } from "./imports.service";
import {
  bankImportsQuerySchema,
  createBankImportSchema,
  type BankImportsQuery,
  type CreateBankImportInput,
} from "./dto/imports.schemas";

@RequireModule("accounting")
@Controller("finance/bank-imports")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ImportsController {
  constructor(private readonly service: ImportsService) {}

  @Get()
  @RequirePermission("accounting:banking:read")
  list(
    @Query(new ZodValidationPipe(bankImportsQuerySchema)) query: BankImportsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listImports(u, query);
  }

  @Post()
  @RequirePermission("accounting:banking:import")
  create(
    @Body(new ZodValidationPipe(createBankImportSchema)) body: CreateBankImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createImport(u, body);
  }
}
