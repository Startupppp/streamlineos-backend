import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, RawBodyRequest, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmMailboxService } from "./crm-mailbox.service";

const enableMailboxSchema = z
  .object({ connectionId: z.number().int().positive() })
  .strict();

type EnableMailboxInput = z.infer<typeof enableMailboxSchema>;

/**
 * Pointing a connected mailbox at the CRM, and stopping it again.
 *
 * Authorising the mailbox is the provider's flow and belongs to the
 * integrations module. This is the separate, smaller decision: whether what
 * arrives there should become customer records.
 */
@Controller("crm/mailboxes")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmMailboxController {
  constructor(private readonly mailboxes: CrmMailboxService) {}

  /**
   * The provider's push notification.
   *
   * `@Public()` because a provider has no session — which is exactly why the
   * body is never trusted for anything except naming which mailbox to look up.
   * The row's own secret verifies the signature and the row supplies the tenant.
   *
   * **Always 204, whatever happened.** A bad signature, an unknown mailbox and a
   * successful sweep are indistinguishable from outside, because telling them
   * apart would answer "does this deployment sync that address?" for anybody who
   * asks — and a mailbox address is a person. The sweep behind it is the truth
   * regardless; push only pulls it forward.
   */
  @Post("push")
  @Public()
  @HttpCode(204)
  async push(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-mailbox-signature") signature: string | undefined,
  ): Promise<void> {
    const raw = req.rawBody?.toString("utf8") ?? "";
    await this.mailboxes.push(raw, signature);
  }

  @Get()
  @RequirePermission("crm:ingress:submit")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.mailboxes.list(u.orgId);
  }

  @Post()
  @Idempotent("crm.mailbox.enable")
  @RequirePermission("crm:ingress:submit")
  enable(
    @Body(new ZodValidationPipe(enableMailboxSchema)) body: EnableMailboxInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailboxes.enable(u.orgId, u.userId, body.connectionId);
  }

  /** Stops the feed. Nothing already filed is removed — those are real records. */
  @Delete(":crmMailboxSyncId")
  @RequirePermission("crm:ingress:submit")
  disable(
    @Param("crmMailboxSyncId") crmMailboxSyncId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailboxes.disable(u.orgId, crmMailboxSyncId);
  }

  /**
   * Read one mailbox forward now.
   *
   * The reconciling half of "near real time via push". Push is the fast path;
   * this closes whatever gap push left, and is also what a person clicks when
   * they want to know the CRM is current.
   */
  @Post(":crmMailboxSyncId/sync")
  @RequirePermission("crm:ingress:submit")
  sync(
    @Param("crmMailboxSyncId") crmMailboxSyncId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailboxes.sync(u.orgId, crmMailboxSyncId);
  }

  @Post("sync")
  @RequirePermission("crm:ingress:submit")
  sweepAll(@CurrentUser() u: CurrentUserContext) {
    return this.mailboxes.sweepAll(u.orgId);
  }
}
