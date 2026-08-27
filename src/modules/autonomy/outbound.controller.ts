import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { composeOutboundSchema, type ComposeOutboundInput } from "./dto/outbound.schemas";
import { OutboundService } from "./outbound.service";

/**
 * The one door into the outbound loop, and the only thing that starts a run.
 *
 * Everything downstream of it is autonomous — the drafting, the hold, the
 * second look at the world and the send all happen without anybody being asked
 * again — so this route is not "send a message". It is "consider this customer",
 * and its most common honest answer is a refusal with a reason.
 *
 * Behind `crm:autonomy:manage` rather than the view key, and rather than a key
 * of its own. `manage` already governs whether an action type runs at all, and
 * somebody who can switch outbound on for the whole organisation is not
 * meaningfully restrained by being unable to start one message. A separate key
 * would also have to be catalogued and backfilled to every existing tenant, and
 * an uncatalogued key is the silent 403-by-signup-date that
 * `gated-keys-are-catalogued.spec.ts` exists to catch.
 *
 * There is no route here to send immediately, skip the window, or force a class.
 * The hold is the only safeguard on an action that cannot be recalled, and an
 * endpoint that bypassed it would make the safeguard optional for whoever knew
 * about it.
 */
@Controller("crm/autonomy/outbound")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OutboundController {
  constructor(private readonly outbound: OutboundService) {}

  /**
   * Idempotent, because a retried POST must not become two messages.
   *
   * The database catches the duplicate too — `uniq_autonomy_holds_live_outbound`
   * turns a second live hold on one message into a 409 — but that index protects
   * one message rather than one request, and a client that retried a timeout
   * would otherwise have paid for a second draft and held a second, differently
   * worded message to the same customer.
   */
  @Post()
  @Idempotent("crm.autonomy.outbound-compose")
  @RequirePermission("crm:autonomy:manage")
  compose(
    @Body(new ZodValidationPipe(composeOutboundSchema)) body: ComposeOutboundInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbound.composeAndHold({
      organizationId: u.orgId,
      partyId: body.partyId,
      dealId: body.dealId ?? null,
    });
  }
}
