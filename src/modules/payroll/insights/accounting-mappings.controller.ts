import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingMappingsService } from "./accounting-mappings.service";

interface CreateMappingBody {
  componentId?: number;
  category?: string;
  ledgerName: string;
  costCenterSource?: string;
  notes?: string;
}

interface UpdateMappingBody {
  componentId?: number | null;
  category?: string | null;
  ledgerName?: string;
  costCenterSource?: string | null;
  notes?: string | null;
}

@Controller("payroll/accounting-mappings")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("payroll:settings:manage")
export class AccountingMappingsController {
  constructor(private readonly accountingMappingsService: AccountingMappingsService) {}

  @Get()
  async list(@CurrentUser() u: CurrentUserContext) {
    return this.accountingMappingsService.list(u.orgId);
  }

  @Post()
  async create(
    @Body() body: CreateMappingBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingMappingsService.create(u.orgId, body);
  }

  @Patch(":id")
  async update(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateMappingBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingMappingsService.update(u.orgId, id, body);
  }

  @Delete(":id")
  async remove(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingMappingsService.remove(u.orgId, id);
  }
}
