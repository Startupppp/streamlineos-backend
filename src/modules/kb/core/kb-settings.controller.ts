import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbSettingsService } from "./kb-settings.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbSettingsSchema } from "./dto/kb-core-response.schemas";

const updateKbSettingsSchema = z.object({
  trashRetentionDays: z.number().int().min(1).max(365),
});

type UpdateKbSettingsInput = z.infer<typeof updateKbSettingsSchema>;

@Controller("kb/settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSettingsController {
  constructor(private readonly settings: KbSettingsService) {}

  @Get()
  @RequirePermission("kb:settings:manage")
  @ResponseSchema(kbSettingsSchema)
  async get(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.settings.getOrgSettings(u.orgId);
  }

  @Patch()
  @RequirePermission("kb:settings:manage")
  @Validate({ body: updateKbSettingsSchema })
  @ResponseSchema(kbSettingsSchema)
  async update(
    @Body() body: UpdateKbSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.settings.upsertOrgSettings(u.orgId, body);
  }
}
