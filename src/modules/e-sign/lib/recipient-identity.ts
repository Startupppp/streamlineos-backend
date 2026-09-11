import { BadRequestException, ForbiddenException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { SignAuditService } from "../sign-audit.service";
import { SignTokensService } from "../sign-tokens.service";
import { SignNotificationsService } from "../sign-notifications.service";
import type { SmsSenderPort } from "../sms/sms-sender.port";
import {
  SELF_SERVE_AUTH_METHODS,
  type PublicAuthInput,
  type PublicConsentInput,
} from "../dto/e-sign.schemas";
import { withRecipientSession, type PublicRequestContext } from "./recipient-session";

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
  /** The SMS channel for `otp_sms`; reports honestly when nothing is configured. */
  readonly sms: SmsSenderPort;
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
    if (recipient.authMethod !== "otp_email" && recipient.authMethod !== "otp_sms") {
      throw new BadRequestException("OTP is not enabled for this recipient");
    }

    const viaSms = recipient.authMethod === "otp_sms";
    if (viaSms && !recipient.phone) throw new BadRequestException("No phone number on file for OTP delivery");
    if (!viaSms && !recipient.email) throw new BadRequestException("No email on file for OTP delivery");

    /**
     * Checked before the code is minted, not after. Storing a hash and an
     * expiry and then failing to deliver leaves the recipient staring at a
     * code entry box for a message that was never sent — and the stored hash
     * would make a later, working attempt look like a replay.
     */
    if (viaSms && !deps.sms.isConfigured()) {
      throw new ServiceUnavailableException(
        "SMS one-time codes are not available in this environment",
      );
    }

    const otp = deps.tokens.generateOtp();
    await deps.db
      .update(signRecipients)
      .set({ otpCodeHash: deps.tokens.hash(otp), otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000), otpAttempts: 0 })
      .where(eq(signRecipients.id, recipient.id));

    if (viaSms) {
      await deps.sms.send(
        recipient.phone!,
        `Your signing code is ${otp}. It expires in 10 minutes.`,
      );
    } else {
      await deps.notifications.sendOtpCode(recipient.email!, recipient.name, otp);
    }
    return { sent: true, via: viaSms ? "sms" : "email" };
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
    } else if (recipient.authMethod === "otp_email" || recipient.authMethod === "otp_sms") {
      /**
       * One branch for both channels, deliberately. The code, the hash, the
       * expiry, the attempt counter and the lockout are properties of the
       * one-time code — not of how it travelled. A separate SMS branch is
       * how the two drift until one of them forgets to check the expiry.
       */
      passed =
        Boolean(input.otpCode) &&
        recipient.otpCodeHash === deps.tokens.hash(input.otpCode ?? "") &&
        Boolean(recipient.otpExpiresAt) &&
        recipient.otpExpiresAt!.getTime() > Date.now();
    } else {
      /*
       * Still the backstop, and still the only place that decides. The list it
       * decides from is now `SELF_SERVE_AUTH_METHODS`, shared with the pre-send
       * validator so an envelope can no longer pass validation and fail here.
       */
      throw new BadRequestException(
        `Authentication method "${recipient.authMethod}" is not yet supported for self-serve signing. Supported: ${SELF_SERVE_AUTH_METHODS.join(", ")}.`,
      );
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
