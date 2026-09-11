import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { WhatsAppChannelsService } from "./whatsapp-channels.service";
import {
  createWhatsappChannelSchema,
  rotateWhatsappChannelSchema,
  updateWhatsappChannelSchema,
  type CreateWhatsappChannelInput,
  type RotateWhatsappChannelInput,
  type UpdateWhatsappChannelInput,
} from "../dto/whatsapp-channel.schemas";

/**
 * Binding a WhatsApp business line to the CRM, and letting go of one.
 *
 * The delivery endpoint next door is `@Public()` because a provider has no
 * session. This is the other half and is the opposite in every respect: it is a
 * person deciding that what arrives on a business number should become customer
 * records, so it is gated, tenant-scoped, and returns no secret it did not just
 * mint.
 *
 * Gated on `crm:ingress:submit` rather than a key of its own, matching
 * `CrmMailboxController` next door — the same decision about the same seam,
 * made about a different channel. A new key would have to be added to the
 * frontend catalog in the other repository to be grantable at all, and a key
 * nobody holds is a surface nobody can reach.
 */
@Controller("crm/ingress/whatsapp-channels")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhatsAppChannelsController {
  constructor(private readonly channels: WhatsAppChannelsService) {}

  /** Every line this organisation has bound, and what the last delivery came to. */
  @Get()
  @RequirePermission("crm:ingress:submit")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.channels.list(u.orgId);
  }

  /**
   * Bind a line.
   *
   * Idempotent because the natural retry — a request whose response was lost —
   * would otherwise come back 409 from the global unique index, which reads as
   * a failure for something that in fact succeeded, and would send an operator
   * looking for a channel they already have.
   */
  @Post()
  @Idempotent("crm.whatsapp-channel.create")
  @RequirePermission("crm:ingress:submit")
  @Validate({ body: createWhatsappChannelSchema })
  create(@Body() body: CreateWhatsappChannelInput, @CurrentUser() u: CurrentUserContext) {
    return this.channels.create(u.orgId, body);
  }

  /**
   * A fresh verify token, and the new app secret if the provider's was rotated.
   *
   * Not idempotent, deliberately: every call is meant to produce a new token,
   * and replaying an old response would hand back a token that no longer
   * verifies anything.
   */
  @Post(":crmWhatsappChannelId/rotate")
  @HttpCode(200)
  @RequirePermission("crm:ingress:submit")
  @Validate({ body: rotateWhatsappChannelSchema })
  rotate(
    @Param("crmWhatsappChannelId") crmWhatsappChannelId: string,
    @Body() body: RotateWhatsappChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.rotate(u.orgId, crmWhatsappChannelId, body);
  }

  /** Stop or restart the feed without giving the line up. */
  @Patch(":crmWhatsappChannelId")
  @RequirePermission("crm:ingress:submit")
  @Validate({ body: updateWhatsappChannelSchema })
  setEnabled(
    @Param("crmWhatsappChannelId") crmWhatsappChannelId: string,
    @Body() body: UpdateWhatsappChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.setEnabled(u.orgId, crmWhatsappChannelId, body);
  }

  /** Give the line up. Everything it filed stays — those are real records. */
  @Delete(":crmWhatsappChannelId")
  @RequirePermission("crm:ingress:submit")
  remove(
    @Param("crmWhatsappChannelId") crmWhatsappChannelId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.remove(u.orgId, crmWhatsappChannelId);
  }
}
