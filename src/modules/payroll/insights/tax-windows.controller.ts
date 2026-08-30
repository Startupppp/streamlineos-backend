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
  @Validate({ body: createTaxWindowBodySchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateTaxWindowBody,
  ) {
    return this.taxWindowsService.create(u.orgId, body);
  }

  @Patch(":windowId")
  @Validate({ params: windowIdParams, body: patchTaxWindowBodySchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("windowId", ParseIntPipe) windowId: number,
    @Body() body: PatchTaxWindowBody,
  ) {
    return this.taxWindowsService.update(u.orgId, windowId, body, u.userId);
  }
}
