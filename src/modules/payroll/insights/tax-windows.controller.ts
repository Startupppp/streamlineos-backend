import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
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
  createTaxWindowBodySchema,
  patchTaxWindowBodySchema,
  type CreateTaxWindowBody,
  type PatchTaxWindowBody,
} from "../hr-payroll/dto/payroll.schemas";
import { TaxWindowsService } from "./tax-windows.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const windowIdParams = z.object({ windowId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/tax-windows")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequirePermission("payroll:tax:manage")
export class TaxWindowsController {
  constructor(private readonly taxWindowsService: TaxWindowsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.taxWindowsService.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createTaxWindowBodySchema)) body: CreateTaxWindowBody,
  ) {
    return this.taxWindowsService.create(u.orgId, body);
  }

  @Patch(":windowId")
  @Validate({ params: windowIdParams })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("windowId", ParseIntPipe) windowId: number,
    @Body(new ZodValidationPipe(patchTaxWindowBodySchema)) body: PatchTaxWindowBody,
  ) {
    return this.taxWindowsService.update(u.orgId, windowId, body, u.userId);
  }
}
