import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { GeofencingService } from "./geofencing.service";

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
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createZoneSchema)) body: CreateZoneInput,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":zoneId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("zoneId", ParseIntPipe) zoneId: number,
    @Body(new ZodValidationPipe(updateZoneSchema)) body: UpdateZoneInput,
  ) {
    return this.service.update(u.orgId, zoneId, body);
  }

  @Delete(":zoneId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  remove(@CurrentUser() u: CurrentUserContext, @Param("zoneId", ParseIntPipe) zoneId: number) {
    return this.service.remove(u.orgId, zoneId);
  }
}
