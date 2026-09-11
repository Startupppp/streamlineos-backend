import { Controller, Get, Patch, Post, Put, Param, Body, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SettingsService } from "./settings.service";
import { ShelfLifeRulesService } from "./shelf-life-rules.service";
import {
  updateSettingsSchema,
  updateNumberSequenceSchema,
  putShelfLifeRuleSchema,
  type UpdateSettingsInput,
  type UpdateNumberSequenceInput,
  type PutShelfLifeRuleInput,
} from "./dto/settings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  invSettingsResponseSchema,
  listNumberSequencesResponseSchema,
  updateNumberSequenceResponseSchema,
  healthResponseSchema,
  expireReservationsResponseSchema,
} from "./dto/settings-response.schemas";

const sequenceIdParams = z.object({ sequenceId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/settings")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvSettingsController {
  constructor(
    private readonly svc: SettingsService,
    private readonly shelfLife: ShelfLifeRulesService,
  ) {}

  @Get()
  @ResponseSchema(invSettingsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSettings(u.orgId);
  }

  /**
   * E1. Read-only, and behind the read key every inventory role holds rather
   * than the administration key, because the packs decide which fields the form
   * renders for the person filling it in.
   */
  @Get("packs")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  getPacks(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getPacks(u.orgId);
  }

  @Patch()
  @ResponseSchema(invSettingsResponseSchema)
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
  @ResponseSchema(listNumberSequencesResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  listNumberSequences(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listNumberSequences(u.orgId);
  }

  @Patch("number-sequences/:sequenceId")
  @ResponseSchema(updateNumberSequenceResponseSchema)
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
  @ResponseSchema(healthResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  getHealth(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getHealth(u.orgId);
  }

  /**
   * D2. The minimum-shelf-life contracts — the house floor and every customer
   * that negotiated their own.
   *
   * Behind the administration key rather than a read key: a floor decides which
   * lots an allocation may take, so it is policy, not a display preference.
   */
  @Get("shelf-life-rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  listShelfLifeRules(@CurrentUser() u: CurrentUserContext) {
    return this.shelfLife.list(u.orgId);
  }

  @Put("shelf-life-rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  putShelfLifeRule(
    @Body(new ZodValidationPipe(putShelfLifeRuleSchema)) body: PutShelfLifeRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.shelfLife.put(u.orgId, u.userId, body);
  }

  @Post("maintenance/expire-reservations")
  @BodylessAction()
  @ResponseSchema(expireReservationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  expireReservations(@CurrentUser() u: CurrentUserContext) {
    return this.svc.expireReservations(u.orgId, u.userId);
  }
}
