import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { systemEnvelopeScope } from "./sign-envelope-scope";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignEnvelopeDispatchService } from "./sign-envelope-dispatch.service";
import {
  canTransitionEnvelope,
  isEnvelopeEditable,
  isEnvelopeSignable,
  isEnvelopeTerminal,
  type SignEnvelopeStatus,
} from "./sign-state";
import type {
  VoidEnvelopeInput,
  CorrectEnvelopeInput,
  ExtendExpirationInput,
} from "./dto/e-sign.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";
import { registerAfterCommit } from "../../common/tenant/tenant-context";

@Injectable()
export class SignEnvelopeLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly recipients: SignRecipientsService,
    private readonly notifications: SignNotificationsService,
    private readonly integrations: SignIntegrationsService,
    private readonly dispatch: SignEnvelopeDispatchService,
  ) {}

  private async mustGet(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(
        eq(signEnvelopes.id, envelopeId),
        eq(signEnvelopes.orgId, orgId),
      ),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  async voidEnvelope(
    orgId: string,
    envelopeId: number,
    input: VoidEnvelopeInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!canTransitionEnvelope(envelope.status, "voided")) {
      throw new ForbiddenException(
        `Cannot void an envelope in status "${envelope.status}"`,
      );
    }

    const updated = await this.db.transaction(async (tx) => {
      await tx
        .update(signRecipients)
        .set({ tokenRevokedAt: new Date() })
        .where(
          and(
            eq(signRecipients.orgId, orgId),
            eq(signRecipients.envelopeId, envelopeId),
            isNull(signRecipients.completedAt),
          ),
        );

      const [row] = await tx
        .update(signEnvelopes)
        .set({
          status: "voided",
          voidedAt: new Date(),
          voidedByMembershipId: actor.membershipId,
          voidReason: input.reason,
        })
        .where(eq(signEnvelopes.id, envelopeId))
        .returning();

      return row;
    });

    const recipientRows = await this.recipients.listForEnvelope(
      systemEnvelopeScope(orgId),
      null,
      envelopeId,
    );
    /*
     * The inner `transaction` above is a savepoint inside the request's
     * transaction, so "after it returns" is still before anything is durable.
     * A voided notice that goes out and is then rolled back tells every
     * recipient about a void that never happened; it waits for the commit.
     */
    const notifyRecipients = async () => {
      for (const r of recipientRows) {
        if (r.email && r.status !== "completed") {
          await this.notifications.sendVoidedToRecipient(
            r.email,
            r.name,
            envelope.title,
            input.reason,
          );
        }
      }
    };
    if (!registerAfterCommit(notifyRecipients)) await notifyRecipients();

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_voided",
      eventMessage: input.reason,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    this.integrations.emitEnvelopeEvent(updated, "voided", {
      reason: input.reason,
    });

    return updated;
  }

  async correct(
    orgId: string,
    envelopeId: number,
    input: CorrectEnvelopeInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (isEnvelopeTerminal(envelope.status)) {
      throw new ForbiddenException(
        "Completed or voided envelopes cannot be corrected",
      );
    }

    /*
     * Each patched recipient must belong to THIS envelope. `recipients.update`
     * is org-bound only, so without this a `sign:envelope:correct` holder could
     * reach any recipient in the organisation through any envelope's correct
     * route, and the audit row would land on the wrong envelope. Out of
     * envelope reads as not found, the same answer a foreign id gets.
     */
    for (const patch of input.recipients ?? []) {
      const current = await this.recipients.get(orgId, patch.id);
      if (current.envelopeId !== envelopeId) throw new NotFoundException("Recipient not found");
      const updated = await this.recipients.update(
        orgId,
        patch.id,
        { name: patch.name, email: patch.email, phone: patch.phone },
        actor,
      );
      if (patch.email !== undefined && patch.email !== current.email && updated.email)
        await this.dispatch.reinviteCorrectedRecipient(
          orgId,
          envelopeId,
          { ...updated, email: updated.email },
          actor,
        );
    }

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_corrected",
      eventMessage: input.reason ?? "Envelope corrected",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.mustGet(orgId, envelopeId);
  }

  async extendExpiration(
    orgId: string,
    envelopeId: number,
    input: ExtendExpirationInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    const newExpiresAt = new Date(input.expiresAt);
    if (newExpiresAt.getTime() <= Date.now())
      throw new BadRequestException("New expiration must be in the future");

    /*
     * Only an envelope that can still be signed, or one that expired and can
     * be reopened, has an expiry to move. A completed or voided envelope is
     * closed history; a declined one waits on a correction, not a date.
     */
    const reopening = envelope.status === "expired";
    if (!reopening && !isEnvelopeSignable(envelope.status) && !isEnvelopeEditable(envelope.status))
      throw new ConflictException(`A ${envelope.status} envelope's expiration cannot be extended`);
    if (reopening && !canTransitionEnvelope(envelope.status, "sent"))
      throw new ConflictException("This envelope cannot be reopened");

    const nextStatus: SignEnvelopeStatus = reopening ? "sent" : envelope.status;

    await this.db
      .update(signRecipients)
      .set({ tokenExpiresAt: newExpiresAt })
      .where(
        and(
          eq(signRecipients.orgId, orgId),
          eq(signRecipients.envelopeId, envelopeId),
          isNull(signRecipients.completedAt),
        ),
      );

    const [updated] = await this.db
      .update(signEnvelopes)
      .set({ expiresAt: newExpiresAt, status: nextStatus })
      .where(and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)))
      .returning();

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_extended",
      eventMessage: `Extended expiration to ${newExpiresAt.toISOString()}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    /* The sweep revoked their tokens with the expiry; the reopened envelope needs them back. */
    if (reopening) await this.dispatch.reviveExpiredRecipients(orgId, envelopeId, newExpiresAt, actor);

    return updated;
  }
}
