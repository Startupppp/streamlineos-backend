import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TaxWindowsService } from "./tax-windows.service";

@Controller("payroll/tax-windows")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("payroll:tax:manage")
export class TaxWindowsController {
  constructor(private readonly taxWindowsService: TaxWindowsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.taxWindowsService.list(u.orgId);
  }

  @Post()
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body()
    body: {
      financialYear: string;
      opensAt: string;
      closesAt: string;
      proofDeadline?: string;
      lockDate?: string;
    },
  ) {
    return this.taxWindowsService.create(u.orgId, body);
  }

  @Patch(":id")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body()
    body: {
      opensAt?: string;
      closesAt?: string;
      proofDeadline?: string;
      lockDate?: string;
      status?: string;
    },
  ) {
    return this.taxWindowsService.update(u.orgId, id, body, u.userId);
  }
}
