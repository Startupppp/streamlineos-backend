import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { BiometricService } from "./biometric.service";
import { Validate } from "../../../common/validation/validate.decorator";

const deviceIdParams = z.object({ deviceId: z.coerce.number().int().positive() }).strict();

const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  ipAddress: z.string().min(1).max(45),
  port: z.number().int().positive().optional(),
  vendor: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
});

const updateDeviceSchema = createDeviceSchema.partial();

type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/biometric")
export class BiometricController {
  constructor(private readonly service: BiometricService) {}

  @Get("devices")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  listDevices(@CurrentUser() u: CurrentUserContext) {
    return this.service.listDevices(u.orgId);
  }

  @Post("devices")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ body: createDeviceSchema })
  createDevice(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateDeviceInput,
  ) {
    return this.service.createDevice(u.orgId, body);
  }

  @Patch("devices/:deviceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: deviceIdParams, body: updateDeviceSchema })
  updateDevice(
    @CurrentUser() u: CurrentUserContext,
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: UpdateDeviceInput,
  ) {
    return this.service.updateDevice(u.orgId, deviceId, body);
  }

  @Get("logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  getLogs(@CurrentUser() u: CurrentUserContext) {
    return this.service.getLogs(u.orgId);
  }
}
