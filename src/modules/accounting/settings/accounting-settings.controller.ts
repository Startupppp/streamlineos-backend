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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  accountingSettingsSchema,
  setupStatusResponseSchema,
  sequenceListResponseSchema,
  sequenceSchema,
} from "./dto/settings-response.schemas";

const entityTypeParams = z.object({ entityType: z.string().min(1) }).strict();

@RequireModule("accounting")
@Controller("accounting/settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AccountingSettingsController {
  constructor(private readonly svc: AccountingSettingsService) {}

  @Get()
  @ResponseSchema(accountingSettingsSchema)
  @RequirePermission("accounting:settings:read")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSettings(u.orgId);
  }

  @Patch()
  @ResponseSchema(accountingSettingsSchema)
  @RequirePermission("accounting:settings:manage")
  @Validate({ body: updateSettingsSchema })
  updateSettings(
    @Body() body: UpdateSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSettings(u, body);
  }

  @Get("setup-status")
  @ResponseSchema(setupStatusResponseSchema)
  @RequirePermission("accounting:settings:read")
  getSetupStatus(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSetupStatus(u.orgId);
  }

  @Get("sequences")
  @ResponseSchema(sequenceListResponseSchema)
  @RequirePermission("accounting:settings:read")
  listSequences(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listSequences(u.orgId);
  }

  @Patch("payment-terms")
  @ResponseSchema(accountingSettingsSchema)
  @RequirePermission("accounting:settings:manage")
  @Validate({ body: upsertPaymentTermsSchema })
  updatePaymentTerms(
    @Body() body: UpsertPaymentTermsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePaymentTerms(u, body);
  }

  @Patch("sequences/:entityType")
  @ResponseSchema(sequenceSchema)
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
