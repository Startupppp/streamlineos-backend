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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SalaryStructureTemplatesService } from "./salary-structure-templates.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/payroll/salary-structures")
export class SalaryStructureTemplatesController {
  constructor(private readonly service: SalaryStructureTemplatesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.create(
      u.orgId,
      body as Parameters<SalaryStructureTemplatesService["create"]>[1],
    );
  }

  @Patch(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.update(
      u.orgId,
      id,
      body as Parameters<SalaryStructureTemplatesService["update"]>[2],
    );
  }

  @Delete(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.remove(u.orgId, id);
  }
}
