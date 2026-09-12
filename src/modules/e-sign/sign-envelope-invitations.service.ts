import { Injectable } from "@nestjs/common";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { SignTokensService } from "./sign-tokens.service";
import { SignNotificationsService } from "./sign-notifications.service";

/** One recipient's pending invitation, resolved while the transaction is live. */
export interface InvitationPlan {
  email: string;
  name: string;
  rawToken: string;
}

/**
 * How a send's invitations leave the process.
 *
 * `after_commit` is the request path: the email is attempted the moment the
 * request transaction commits, so a signer has their link within seconds.
 * `outbox` is bulk send's: the invitation is written to the email outbox
 * inside the row's own transaction and the outbox cron delivers it, so a row
 * is `success` only if its invitation is durably queued, and a pass over five
 * hundred rows does not fan five hundred provider calls out behind it.
 */
export type InvitationDelivery = "after_commit" | "outbox";

@Injectable()
export class SignEnvelopeInvitationsService {
  constructor(
    private readonly tokens: SignTokensService,
    private readonly notifications: SignNotificationsService,
  ) {}

  /**
   * Hand a batch of invitations to the transaction boundary, never to the
   * transaction.
   *
   * The caller's `db` handle is the tenant-aware proxy, so anything issued
   * under an ambient tenant transaction stays inside it — an SMTP outage would
   * hold that transaction's pooled connection for its whole duration, which §4
   * forbids, and a throw partway through the loop rolled the token writes back
   * underneath mail already sitting in inboxes.
   *
   * `registerAfterCommit` is the right one of §4's three mechanisms rather than
   * the outbox: the recipient rows carry only the token *hash*, so an outbox
   * payload would have to hold the raw signing token — a bearer credential in
   * plaintext at rest — whereas a hook that never runs is re-drivable through
   * `resend`, which rotates a fresh token for anyone left at `invited`.
   *
   * It returns false when the ambient context carries no hook array, and §4 is
   * explicit that the fallback is to run inline rather than drop the work.
   *
   * `outbox` delivery is the exception that proves the rule: the outbox row is
   * a database write, so it belongs inside the transaction — the send and its
   * invitation commit together or not at all — and no network call is made
   * here. The token still reaches the outbox row's html either way, since the
   * request path inserts the same row before its first attempt.
   */
  async deliverInvitations(
    invitations: InvitationPlan[],
    senderNameStr: string,
    envelope: { title: string; message: string | null },
    delivery: InvitationDelivery,
  ): Promise<void> {
    if (invitations.length === 0) return;
    if (delivery === "outbox") {
      for (const invitation of invitations) {
        await this.notifications.queueInvitation(
          invitation.email,
          invitation.name,
          senderNameStr,
          envelope.title,
          envelope.message ?? undefined,
          this.tokens.buildSigningUrl(invitation.rawToken),
        );
      }
      return;
    }
    const deliver = async () => {
      for (const invitation of invitations) {
        await this.notifications.sendInvitation(
          invitation.email,
          invitation.name,
          senderNameStr,
          envelope.title,
          envelope.message ?? undefined,
          this.tokens.buildSigningUrl(invitation.rawToken),
        );
      }
    };
    if (!registerAfterCommit(deliver)) await deliver();
  }
}
