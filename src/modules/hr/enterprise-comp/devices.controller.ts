import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listDevicesResponseSchema, createDeviceResponseSchema, updateDeviceResponseSchema, listSyncLogsResponseSchema, ingestSyncLogResponseSchema, listFailedSyncsResponseSchema, detectDuplicatePunchesResponseSchema, listDeviceMappingsResponseSchema, createDeviceMappingResponseSchema } from "./dto/enterprise-comp-response.schemas"

const deviceIdParams = z.object({ deviceId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/enterprise/comp/devices")
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly service: DevicesService) {}

  @ResponseSchema(listDevicesResponseSchema)
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @Validate({ query: listTimeDevicesSchema })
  list(
    @Query() query: ListTimeDevicesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listDevices(u.orgId, query);
  }

  @ResponseSchema(createDeviceResponseSchema)
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(201)
  @Validate({ body: createTimeDeviceSchema })
  create(
    @Body() body: CreateTimeDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createDevice(u.orgId, u.userId, body);
  }

  @ResponseSchema(updateDeviceResponseSchema)
  @Patch(":deviceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @Validate({ params: deviceIdParams, body: updateTimeDeviceSchema })
  update(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: UpdateTimeDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDevice(u.orgId, deviceId, u.userId, body);
  }

  @NoContentResponse()
  @Delete(":deviceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(204)
  @Validate({ params: deviceIdParams })
  remove(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteDevice(u.orgId, deviceId, u.userId);
  }

  @ResponseSchema(listSyncLogsResponseSchema)
  @Get("sync-logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @Validate({ query: listSyncLogsSchema })
  listSyncLogs(
    @Query() query: ListSyncLogsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listSyncLogs(u.orgId, query);
  }

  @ResponseSchema(ingestSyncLogResponseSchema)
  @Post("sync-logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(201)
  @Validate({ body: createSyncLogSchema })
  ingestSyncLog(
    @Body() body: CreateSyncLogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.ingestSyncLog(u.orgId, body);
  }

  @ResponseSchema(listFailedSyncsResponseSchema)
  @Get("failed-syncs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  failedSyncs(@CurrentUser() u: CurrentUserContext) {
    return this.service.listFailedSyncs(u.orgId);
  }

  @ResponseSchema(detectDuplicatePunchesResponseSchema)
  @Get(":deviceId/duplicate-punches")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @Validate({ params: deviceIdParams })
  duplicatePunches(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.detectDuplicatePunches(u.orgId, deviceId);
  }

  @ResponseSchema(listDeviceMappingsResponseSchema)
  @Get("mappings")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @Validate({ query: listDeviceMappingsSchema })
  listMappings(
    @Query() query: ListDeviceMappingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listMappings(u.orgId, query);
  }

  @ResponseSchema(createDeviceMappingResponseSchema)
  @Post("mappings")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:biometric:manage")
  @HttpCode(201)
  @Validate({ body: createDeviceMappingSchema })
  createMapping(
    @Body() body: CreateDeviceMappingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createMapping(u.orgId, u.userId, body);
  }
}
