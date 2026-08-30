import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingSettingsService } from "./accounting-settings.service";
import {
  updateSettingsSchema,
  updateSequenceSchema,
  upsertPaymentTermsSchema,
  SEQUENCE_ENTITY_TYPES,
  type UpdateSettingsInput,
  type UpdateSequenceInput,
  type SequenceEntityType,
  type UpsertPaymentTermsInput,
} from "./dto/settings.schemas";
import { BadRequestException } from "@nestjs/common";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const entityTypeParams = z.object({ entityType: z.string().min(1) }).strict();

@RequireModule("accounting")
@Controller("accounting/settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AccountingSettingsController {
  constructor(private readonly svc: AccountingSettingsService) {}

  @Get()
  @RequirePermission("accounting:settings:read")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSettings(u.orgId);
  }

  @Patch()
  @RequirePermission("accounting:settings:manage")
  @Validate({ body: updateSettingsSchema })
  updateSettings(
    @Body() body: UpdateSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSettings(u, body);
  }

  @Get("setup-status")
  @RequirePermission("accounting:settings:read")
  getSetupStatus(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSetupStatus(u.orgId);
  }

  @Get("sequences")
  @RequirePermission("accounting:settings:read")
  listSequences(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listSequences(u.orgId);
  }

  @Patch("payment-terms")
  @RequirePermission("accounting:settings:manage")
  @Validate({ body: upsertPaymentTermsSchema })
  updatePaymentTerms(
    @Body() body: UpsertPaymentTermsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePaymentTerms(u, body);
  }

  @Patch("sequences/:entityType")
  @RequirePermission("accounting:settings:manage")
  @Validate({ params: entityTypeParams, body: updateSequenceSchema })
  updateSequence(
    @Param("entityType") entityType: string,
    @Body() body: UpdateSequenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!isSequenceEntityType(entityType)) {
      throw new BadRequestException(`Invalid entityType. Allowed: ${SEQUENCE_ENTITY_TYPES.join(", ")}`);
    }
    return this.svc.updateSequence(u, entityType, body);
  }
}

const SEQUENCE_ENTITY_TYPE_VALUES: ReadonlyArray<string> = SEQUENCE_ENTITY_TYPES;

function isSequenceEntityType(value: string): value is SequenceEntityType {
  return SEQUENCE_ENTITY_TYPE_VALUES.includes(value);
}
