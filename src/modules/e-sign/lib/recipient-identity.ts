import { BadRequestException, ForbiddenException, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { SignAuditService } from "../sign-audit.service";
import { SignTokensService } from "../sign-tokens.service";
import { SignNotificationsService } from "../sign-notifications.service";
import type { PublicRequestContext } from "../sign-public-form.service";
import type { PublicAuthInput, PublicConsentInput } from "../dto/e-sign.schemas";
import { withRecipientSession } from "./recipient-session";

/**
 * Proving who is at the other end of a signing link, and that they agreed to
 * sign electronically at all.
 *
 * Split from the signing acts because the question is different and so is the
 * failure: everything here answers "is this the named recipient", refuses with
 * 403, and writes an audit row whether it passed or failed — the record of a
 * FAILED attempt is the point, since a disputed signature is argued from the
 * attempts as much as from the signature. Nothing here touches a field or a
 * document.
 *
 * The order these enforce is a ladder and each rung is checked by the next:
 * authenticate requires an active session, consent requires `authenticatedAt`,
 * and every act after this requires `consentAcceptedAt`.
 */
export interface RecipientIdentityDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly tokens: SignTokensService;
  readonly audit: SignAuditService;
  readonly notifications: SignNotificationsService;
  /**
   * The session-state gate, bound from the service rather than exported.
   *
   * It is private there on purpose: it derives ten states from the envelope and
   * the recipient and refuses all but one, and a second caller reaching it
   * directly could refuse on a different set. Passed as a closure so this file
   * uses it without being able to redefine it.
   */
  readonly assertActive: (
    recipient: typeof signRecipients.$inferSelect,
    envelope: typeof signEnvelopes.$inferSelect,
  ) => void;
}

const MAX_AUTH_ATTEMPTS = 5;

export async function requestOtp(deps: RecipientIdentityDeps, token: string) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);
    if (recipient.authMethod !== "otp_email") throw new BadRequestException("OTP is not enabled for this recipient");
    if (!recipient.email) throw new BadRequestException("No email on file for OTP delivery");

    const otp = deps.tokens.generateOtp();
    await deps.db
      .update(signRecipients)
      .set({ otpCodeHash: deps.tokens.hash(otp), otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000), otpAttempts: 0 })
      .where(eq(signRecipients.id, recipient.id));

    await deps.notifications.sendOtpCode(recipient.email, recipient.name, otp);
    return { sent: true };
  });
}

export async function authenticate(
  deps: RecipientIdentityDeps,
  token: string,
  input: PublicAuthInput,
  ctx: PublicRequestContext,
) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);

    if (recipient.authLockedUntil && recipient.authLockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException("Too many failed attempts. Please try again later.");
    }

    let passed: boolean;
    if (recipient.authMethod === "email_link") {
      passed = true;
    } else if (recipient.authMethod === "access_code") {
      passed = Boolean(input.accessCode) && recipient.accessCodeHash === deps.tokens.hash(input.accessCode ?? "");
    } else if (recipient.authMethod === "otp_email") {
      passed =
        Boolean(input.otpCode) &&
        recipient.otpCodeHash === deps.tokens.hash(input.otpCode ?? "") &&
        Boolean(recipient.otpExpiresAt) &&
        recipient.otpExpiresAt!.getTime() > Date.now();
    } else {
      throw new BadRequestException(`Authentication method "${recipient.authMethod}" is not yet supported for self-serve signing`);
    }

    if (!passed) {
      const attempts = recipient.failedAuthAttempts + 1;
      await deps.db
        .update(signRecipients)
        .set({
          failedAuthAttempts: attempts,
          authLockedUntil: attempts >= MAX_AUTH_ATTEMPTS ? new Date(Date.now() + 15 * 60 * 1000) : recipient.authLockedUntil,
        })
        .where(eq(signRecipients.id, recipient.id));

      await deps.audit.record({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        actorType: "external_signer",
        actorName: recipient.name,
        actorEmail: recipient.email,
        eventType: "authentication_failed",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw new ForbiddenException("Authentication failed");
    }

    await deps.db
      .update(signRecipients)
      .set({ status: "authenticated", authenticatedAt: new Date(), failedAuthAttempts: 0, authLockedUntil: null })
      .where(eq(signRecipients.id, recipient.id));

    await deps.audit.record({
      orgId: envelope.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: recipient.name,
      actorEmail: recipient.email,
      eventType: "authentication_passed",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return { authenticated: true };
  });
}

export async function acceptConsent(
  deps: RecipientIdentityDeps,
  token: string,
  input: PublicConsentInput,
  ctx: PublicRequestContext,
) {
  return withRecipientSession(deps.db, deps.tokens, deps.logger, token, async ({ recipient, envelope }) => {
    deps.assertActive(recipient, envelope);
    if (!recipient.authenticatedAt) throw new ForbiddenException("Please complete authentication first");

    await deps.db
      .update(signRecipients)
      .set({
        consentAcceptedAt: new Date(),
        consentIp: ctx.ipAddress,
        consentUserAgent: ctx.userAgent,
        consentDisclosureVersion: input.disclosureVersion,
      })
      .where(eq(signRecipients.id, recipient.id));

    await deps.audit.record({
      orgId: envelope.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: recipient.name,
      actorEmail: recipient.email,
      eventType: "consent_accepted",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      eventPayload: { disclosureVersion: input.disclosureVersion },
    });

    return { accepted: true };
  });
}
