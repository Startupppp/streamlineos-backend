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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrSensitiveService } from "./hr-sensitive.service";
import { updateSensitiveSchema, type UpdateSensitiveInput } from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSensitiveController {
  constructor(private readonly sensitive: HrSensitiveService) {}

  @Get(":employeeId/sensitive")
  @RequirePermission("hr:sensitive:view")
  get(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    return this.sensitive.get(u.orgId, employeeId, u.userId, ip);
  }

  @Patch(":employeeId/sensitive")
  @RequirePermission("hr:sensitive:manage")
  update(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Body(new ZodValidationPipe(updateSensitiveSchema)) body: UpdateSensitiveInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    return this.sensitive.update(u.orgId, employeeId, u.userId, body, ip);
  }
}
