import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";

import { HrSensitiveService } from "./hr-sensitive.service";
import { updateSensitiveSchema, type UpdateSensitiveInput } from "./dto/hr-core.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const employeeIdParams = z.object({ employeeId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSensitiveController {
  constructor(private readonly sensitive: HrSensitiveService) {}

  @Get(":employeeId/sensitive")
  @RequirePermission("hr:sensitive:view")
  @Validate({ params: employeeIdParams })
  get(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    return this.sensitive.get(u.orgId, employeeId, u.userId, actingMembershipId(u.principal), ip);
  }

  @Patch(":employeeId/sensitive")
  @RequirePermission("hr:sensitive:manage")
  @Validate({ params: employeeIdParams })
  update(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Body(new ZodValidationPipe(updateSensitiveSchema)) body: UpdateSensitiveInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    return this.sensitive.update(u.orgId, employeeId, u.userId, actingMembershipId(u.principal), body, ip);
  }
}
