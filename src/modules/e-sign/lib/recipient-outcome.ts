import { BadRequestException, ForbiddenException, Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { organizationMembers, signEnvelopes, signFields, signRecipients } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { SignAuditService } from "../sign-audit.service";
import { SignTokensService } from "../sign-tokens.service";
import { SignEnvelopesService } from "../sign-envelopes.service";
import { SignFinalizationService } from "../sign-finalization.service";
import { SignNotificationsService } from "../sign-notifications.service";
import { SignIntegrationsService } from "../sign-integrations.service";
import type { DeclineInput } from "../dto/e-sign-public.schemas";
import { withRecipientSession, type PublicRequestContext } from "./recipient-session";

/**
 * The two ways a recipient leaves the envelope for good.
 *
 * Both are one-way doors, and that is why they sit together rather than with
 * the field edits they follow: each revokes the token in the same statement
 * that sets the terminal status, and each does so with a CONDITIONAL update
 * whose `where` names the status it expects. A zero-row result is the race
 * being lost — a second tab, a retried request — and is reported as "no longer
 * active" rather than written twice. Nothing else in the public surface needs
 * that treatment, because nothing else is irreversible.
 *
 * Completing is also the only place the envelope's own state can advance, so it
 * is the only one that reaches the finalizer.
 */
export interface RecipientOutcomeDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly tokens: SignTokensService;
  readonly audit: SignAuditService;
  readonly envelopes: SignEnvelopesService;
  readonly finalization: SignFinalizationService;
  readonly notifications: SignNotificationsService;
  readonly integrations: SignIntegrationsService;
  /** The session-state gate, bound from the service. See `RecipientIdentityDeps`. */
  readonly assertActive: (
    recipient: typeof signRecipients.$inferSelect,
    envelope: typeof signEnvelopes.$inferSelect,
  ) => void;
}

export async function complete(deps: RecipientOutcomeDeps, token: string, ctx: PublicRequestContext) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);
    if (!recipient.consentAcceptedAt) throw new ForbiddenException("Please accept the electronic signature consent first");

    await deps.db
      .update(signFields)
      .set({ valueJson: { value: new Date().toISOString().slice(0, 10) }, completedAt: new Date() })
      .where(
        and(
          eq(signFields.orgId, envelope.orgId),
          eq(signFields.recipientId, recipient.id),
          eq(signFields.fieldType, "date_signed"),
          isNull(signFields.completedAt),
        ),
      );

    const refreshedFields = await deps.db.query.signFields.findMany({ where: eq(signFields.recipientId, recipient.id) });
    const incomplete = refreshedFields.filter((f) => f.required && !f.completedAt);
    if (incomplete.length > 0) {
      throw new BadRequestException({
        message: "Please complete all required fields before finishing.",
        fieldIds: incomplete.map((f) => f.id),
      });
    }

    const claimed = await deps.db
      .update(signRecipients)
      .set({ status: "completed", completedAt: new Date(), tokenRevokedAt: new Date() })
      .where(and(eq(signRecipients.id, recipient.id), eq(signRecipients.status, "authenticated")))
      .returning();

    if (claimed.length === 0) {
      throw new BadRequestException("This document has already been completed or is no longer active.");
    }

    await deps.audit.record({
      orgId: envelope.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: recipient.name,
      actorEmail: recipient.email,
      eventType: "recipient_completed",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    deps.integrations.emitRecipientCompleted(envelope, { id: recipient.id, name: recipient.name, email: recipient.email });

    const outcome = await deps.envelopes.applyRecipientOutcome(envelope.orgId, envelope.id);
    if (outcome.becameCompleted) {
      await deps.finalization.finalize(envelope.orgId, envelope.id);
    }

    return { completed: true, envelopeCompleted: outcome.becameCompleted };
  });
}

export async function decline(
  deps: RecipientOutcomeDeps,
  token: string,
  input: DeclineInput,
  ctx: PublicRequestContext,
) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);
    if (!envelope.allowDecline) throw new ForbiddenException("Declining is not permitted for this envelope");

    const claimed = await deps.db
      .update(signRecipients)
      .set({ status: "declined", declinedAt: new Date(), declinedReason: input.reason, tokenRevokedAt: new Date() })
      .where(and(eq(signRecipients.id, recipient.id), eq(signRecipients.status, recipient.status)))
      .returning();
    if (claimed.length === 0) throw new BadRequestException("This document is no longer active.");

    await deps.audit.record({
      orgId: envelope.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: recipient.name,
      actorEmail: recipient.email,
      eventType: "recipient_declined",
      eventMessage: input.reason,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    await deps.envelopes.applyRecipientOutcome(envelope.orgId, envelope.id);

    const declineSenderMember =
      envelope.senderMembershipId != null
        ? await deps.db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, envelope.orgId), eq(organizationMembers.id, envelope.senderMembershipId)),
            with: { user: { columns: { name: true, email: true } } },
          })
        : null;
    if (declineSenderMember?.user?.email) {
      await deps.notifications.sendDeclinedToSender(declineSenderMember.user.email, declineSenderMember.user.name ?? "Sender", envelope.id, envelope.title, recipient.name, input.reason);
    }

    return { declined: true };
  });
}
