import {
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import {
  accountingMappingCreateSchema,
  accountingMappingUpdateSchema,
  type AccountingMappingCreate,
  type AccountingMappingUpdate,
} from "./dto/insights.schemas";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const mappingIdParams = z.object({ mappingId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/accounting-mappings")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequirePermission("payroll:settings:manage")
export class AccountingMappingsController {
  constructor(private readonly accountingMappingsService: AccountingMappingsService) {}

  @Get()
  async list(@CurrentUser() u: CurrentUserContext) {
    return this.accountingMappingsService.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(accountingMappingCreateSchema)) body: AccountingMappingCreate,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingMappingsService.create(u.orgId, body);
  }

  @Patch(":mappingId")
  @Validate({ params: mappingIdParams })
  async update(
    @Param("mappingId", ParseIntPipe) mappingId: number,
    @Body(new ZodValidationPipe(accountingMappingUpdateSchema)) body: AccountingMappingUpdate,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingMappingsService.update(u.orgId, mappingId, body);
  }

  @Delete(":mappingId")
  @HttpCode(204)
  @Validate({ params: mappingIdParams })
  async remove(
    @Param("mappingId", ParseIntPipe) mappingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingMappingsService.remove(u.orgId, mappingId);
  }
}
