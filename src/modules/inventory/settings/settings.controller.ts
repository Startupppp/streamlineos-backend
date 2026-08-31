import { Controller, Get, Patch, Post, Param, Body, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { SettingsService } from "./settings.service";
import {
  updateSettingsSchema,
  updateNumberSequenceSchema,
  type UpdateSettingsInput,
  type UpdateNumberSequenceInput,
} from "./dto/settings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const sequenceIdParams = z.object({ sequenceId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/settings")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSettings(u.orgId);
  }

  @Patch()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  @Validate({ body: updateSettingsSchema })
  updateSettings(
    @Body() body: UpdateSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSettings(u.orgId, u.userId, body);
  }

  @Get("number-sequences")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  listNumberSequences(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listNumberSequences(u.orgId);
  }

  @Patch("number-sequences/:sequenceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  @Validate({ params: sequenceIdParams, body: updateNumberSequenceSchema })
  updateNumberSequence(
    @Param("sequenceId", ParseIntPipe) id: number,
    @Body() body: UpdateNumberSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateNumberSequence(u.orgId, u.userId, id, body);
  }

  @Get("health")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  getHealth(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getHealth(u.orgId);
  }

  @Post("maintenance/expire-reservations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  @BodylessAction()
  expireReservations(@CurrentUser() u: CurrentUserContext) {
    return this.svc.expireReservations(u.orgId, u.userId);
  }
}
