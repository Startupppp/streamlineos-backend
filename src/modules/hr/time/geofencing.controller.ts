import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { GeofencingService } from "./geofencing.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { geofenceRowSchema } from "./dto/time-attendance-response.schemas";

const zoneIdParams = z.object({ zoneId: z.coerce.number().int().positive() }).strict();

const createZoneSchema = z.object({
  name: z.string().min(1).max(100),
  lat: z.string().min(1),
  lng: z.string().min(1),
  radiusMeters: z.number().int().positive().optional(),
});

const updateZoneSchema = createZoneSchema.partial();

type CreateZoneInput = z.infer<typeof createZoneSchema>;
type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/geofencing")
export class GeofencingController {
  constructor(private readonly service: GeofencingService) {}

  @Get()
  @ResponseSchema(z.array(geofenceRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(geofenceRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ body: createZoneSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateZoneInput,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":zoneId")
  @ResponseSchema(geofenceRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: zoneIdParams, body: updateZoneSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("zoneId", ParseIntPipe) zoneId: number,
    @Body() body: UpdateZoneInput,
  ) {
    return this.service.update(u.orgId, zoneId, body);
  }

  @Delete(":zoneId")
  @HttpCode(204)
  @NoContentResponse()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: zoneIdParams })
  remove(@CurrentUser() u: CurrentUserContext, @Param("zoneId", ParseIntPipe) zoneId: number) {
    return this.service.remove(u.orgId, zoneId);
  }
}
