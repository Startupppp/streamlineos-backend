import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signDocuments, signEnvelopes, signFields } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignRecipientsService } from "./sign-recipients.service";
import { SELF_SERVE_AUTH_METHODS, isSelfServeAuthMethod } from "./dto/e-sign.schemas";

const SIGNING_RECIPIENT_TYPES = [
  "signer",
  "approver",
  "in_person_host",
  "internal_reviewer",
] as const;

type SigningRecipientType = (typeof SIGNING_RECIPIENT_TYPES)[number];

export function isSigningType(type: string): type is SigningRecipientType {
  return (SIGNING_RECIPIENT_TYPES as readonly string[]).includes(type);
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
  ) {}

  async validate(orgId: string, envelopeId: number): Promise<EnvelopeValidationResult> {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");

    const errors: string[] = [];

    const documents = await this.db.query.signDocuments.findMany({
      where: and(
        eq(signDocuments.orgId, orgId),
        eq(signDocuments.envelopeId, envelopeId),
      ),
    });
    if (documents.length === 0) errors.push("Envelope has no document");

    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));
    if (signingRecipients.length === 0) errors.push("Envelope has no signer");

    for (const r of signingRecipients) {
      if (r.recipientType !== "in_person_host" && !r.email) {
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
       * Five of the eight methods in `signAuthMethodSchema` — otp_sms, sso,
       * passkey, kba, id_verification — are accepted by the composer and refused
       * by `SignPublicService.authenticate`. Nothing between the two said so, so
       * an envelope configured with any of them validated cleanly, sent, and
       * dead-ended at the recipient with "not yet supported for self-serve
       * signing". The sender learned nothing; the signer learned it instead, at
       * the one moment they can do nothing about it.
       *
       * The check above is the sharper illustration: it carefully insists on a
       * phone number for `otp_sms`, which is a mandatory field for a delivery
       * that never happens.
       */
      if (!isSelfServeAuthMethod(r.authMethod)) {
        errors.push(
          `Recipient "${r.name}" uses "${r.authMethod}" authentication, which self-serve signing cannot complete yet. Supported: ${SELF_SERVE_AUTH_METHODS.join(", ")}.`,
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
