import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signDocuments, signEnvelopes, signFields } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignRecipientsService } from "./sign-recipients.service";
import { SELF_SERVE_AUTH_METHODS, isSelfServeAuthMethod } from "./dto/e-sign.schemas";
import { systemEnvelopeScope } from "./sign-envelope-scope";
import { SMS_SENDER, type SmsSenderPort } from "./sms/sms-sender.port";

const SIGNING_RECIPIENT_TYPES = [
  "signer",
  "approver",
  "in_person_host",
  "internal_reviewer",
] as const;

type SigningRecipientType = (typeof SIGNING_RECIPIENT_TYPES)[number];

export function isSigningType(type: string): type is SigningRecipientType {
  return SIGNING_RECIPIENT_TYPES.some((recipientType) => recipientType === type);
}

export interface EnvelopeValidationResult {
  valid: boolean;
  errors: string[];
}

@Injectable()
export class SignEnvelopeValidationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly recipients: SignRecipientsService,
    @Inject(SMS_SENDER) private readonly sms: SmsSenderPort,
  ) {}

  async validate(orgId: string, envelopeId: number): Promise<EnvelopeValidationResult> {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      columns: { id: true, routingMode: true, expiresAt: true },
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");

    const errors: string[] = [];

    const documents = await this.db.query.signDocuments.findMany({
      columns: { id: true },
      where: and(
        eq(signDocuments.orgId, orgId),
        eq(signDocuments.envelopeId, envelopeId),
      ),
      limit: 1,
    });
    if (documents.length === 0) errors.push("Envelope has no document");

    const recipientRows = await this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));
    if (signingRecipients.length === 0) errors.push("Envelope has no signer");

    for (const r of signingRecipients) {
      /**
       * No exemption for `in_person_host` — see SIGN-P2-01 in
       * SignRecipientsService. An emailless host is never invited and blocks
       * completion forever, so this catches the envelopes created before the
       * rule changed rather than letting them be sent into that state.
       */
      if (!r.email) {
        errors.push(`Recipient "${r.name}" is missing an email address`);
      }
      if (r.authMethod === "otp_sms" && !r.phone) {
        errors.push(
          `Recipient "${r.name}" is missing a phone number for SMS OTP authentication`,
        );
      }
      /*
       * Refused here, before the envelope goes out, rather than by the signing
       * page after it has.
       *
       * Four of the eight methods in `signAuthMethodSchema` — sso, passkey,
       * kba, id_verification — are accepted by the composer and refused
       * by `SignPublicService.authenticate`. Nothing between the two said so, so
       * an envelope configured with any of them validated cleanly, sent, and
       * dead-ended at the recipient with "not yet supported for self-serve
       * signing". The sender learned nothing; the signer learned it instead, at
       * the one moment they can do nothing about it.
       */
      if (!isSelfServeAuthMethod(r.authMethod)) {
        errors.push(
          `Recipient "${r.name}" uses "${r.authMethod}" authentication, which self-serve signing cannot complete yet. Supported: ${SELF_SERVE_AUTH_METHODS.join(", ")}.`,
        );
      }
      /**
       * Enabled is not the same as deliverable. `SignAuthMethodPolicy` refused
       * SMS codes at configuration time when no provider was present, but a
       * provider can be removed after a recipient was configured, and the
       * signer would learn it from `requestOtp` at the end of a link. This is
       * the last moment the sender still holds the envelope.
       */
      if (r.authMethod === "otp_sms" && !this.sms.isConfigured()) {
        errors.push(
          `Recipient "${r.name}" uses SMS one-time codes, but no SMS provider is configured in this environment, so the code could not be delivered.`,
        );
      }
    }
    if (
      envelope.routingMode === "sequential" &&
      signingRecipients.some((r) => !r.routingOrder)
    ) {
      errors.push("All recipients require a routing order for sequential envelopes");
    }

    const fields = await this.db.query.signFields.findMany({
      where: and(
        eq(signFields.orgId, orgId),
        eq(signFields.envelopeId, envelopeId),
      ),
    });
    const recipientById = new Map(recipientRows.map((r) => [r.id, r]));
    for (const f of fields) {
      const recipient = recipientById.get(f.recipientId);
      if (f.required && recipient && !isSigningType(recipient.recipientType)) {
        errors.push(
          `A required field on page ${f.pageNumber} is assigned to a non-signing recipient`,
        );
      }
      if (f.width <= 0 || f.height <= 0)
        errors.push(`A field on page ${f.pageNumber} has invalid coordinates`);
      if (
        f.fieldType === "dropdown" &&
        (!f.optionsJson || f.optionsJson.length === 0)
      ) {
        errors.push("A dropdown field has no options");
      }
      if (
        f.fieldType === "radio" &&
        (!f.optionsJson || f.optionsJson.length < 2)
      ) {
        errors.push("A radio group field has fewer than two options");
      }
    }

    if (envelope.expiresAt && envelope.expiresAt.getTime() < Date.now()) {
      errors.push("Expiration date is in the past");
    }

    return { valid: errors.length === 0, errors };
  }
}
