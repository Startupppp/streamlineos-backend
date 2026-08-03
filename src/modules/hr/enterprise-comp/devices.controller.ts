import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { DevicesService } from "./devices.service";
import {
  createTimeDeviceSchema,
  updateTimeDeviceSchema,
  listTimeDevicesSchema,
  createSyncLogSchema,
  listSyncLogsSchema,
  createDeviceMappingSchema,
  listDeviceMappingsSchema,
  type CreateTimeDeviceInput,
  type UpdateTimeDeviceInput,
  type ListTimeDevicesInput,
  type CreateSyncLogInput,
  type ListSyncLogsInput,
  type CreateDeviceMappingInput,
  type ListDeviceMappingsInput,
} from "./dto/enterprise-comp.schemas";

@RequireModule("hr")
@Controller("hr/enterprise/comp/devices")
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly service: DevicesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  list(
    @Query(new ZodValidationPipe(listTimeDevicesSchema)) query: ListTimeDevicesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listDevices(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTimeDeviceSchema)) body: CreateTimeDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createDevice(u.orgId, u.userId, body);
  }

  @Patch(":deviceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  update(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body(new ZodValidationPipe(updateTimeDeviceSchema)) body: UpdateTimeDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDevice(u.orgId, deviceId, u.userId, body);
  }

  @Delete(":deviceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(204)
  remove(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteDevice(u.orgId, deviceId, u.userId);
  }

  @Get("sync-logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  listSyncLogs(
    @Query(new ZodValidationPipe(listSyncLogsSchema)) query: ListSyncLogsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listSyncLogs(u.orgId, query);
  }

  @Post("sync-logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(201)
  ingestSyncLog(
    @Body(new ZodValidationPipe(createSyncLogSchema)) body: CreateSyncLogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.ingestSyncLog(u.orgId, body);
  }

  @Get("failed-syncs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  failedSyncs(@CurrentUser() u: CurrentUserContext) {
    return this.service.listFailedSyncs(u.orgId);
  }

  @Get(":deviceId/duplicate-punches")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  duplicatePunches(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.detectDuplicatePunches(u.orgId, deviceId);
  }

  @Get("mappings")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  listMappings(
    @Query(new ZodValidationPipe(listDeviceMappingsSchema)) query: ListDeviceMappingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listMappings(u.orgId, query);
  }

  @Post("mappings")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(201)
  createMapping(
    @Body(new ZodValidationPipe(createDeviceMappingSchema)) body: CreateDeviceMappingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createMapping(u.orgId, u.userId, body);
  }
}
