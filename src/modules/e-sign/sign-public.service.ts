import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signDocuments, signEnvelopes, signFields, signPublicForms, signRecipients, signSignatureAssets, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { SignFinalizationService } from "./sign-finalization.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTemplatesService, parseTemplateSnapshot } from "./sign-templates.service";
import { SignSettingsService } from "./sign-settings.service";
import type {
  PublicAuthInput,
  PublicConsentInput,
  PublicFieldValueInput,
  AdoptSignatureInput,
  DeclineInput,
  PublicFormESignSubmitInput,
} from "./dto/e-sign.schemas";

const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"];

const SIGNED_URL_EXPIRY_SECONDS = 900;
const MAX_AUTH_ATTEMPTS = 5;

export interface PublicRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

type SessionState =
  | "active"
  | "not_your_turn"
  | "expired"
  | "revoked"
  | "recipient_completed"
  | "recipient_declined"
  | "envelope_voided"
  | "envelope_expired"
  | "envelope_declined"
  | "envelope_completed";

@Injectable()
export class SignPublicService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly envelopes: SignEnvelopesService,
    private readonly finalization: SignFinalizationService,
    private readonly notifications: SignNotificationsService,
    private readonly templates: SignTemplatesService,
    private readonly settings: SignSettingsService,
    private readonly integrations: SignIntegrationsService,
  ) {}

  async getPublicForm(slug: string) {
    return this.templates.getPublicForm(slug);
  }

  /**
   * A visitor submits a published public form themselves — no sender, no invitation email
   * round-trip. We instantiate + "send" the envelope internally and hand back a ready signing
   * token so the frontend can redirect the visitor straight into their own session.
   */
  async submitPublicForm(slug: string, input: PublicFormESignSubmitInput, ctx: PublicRequestContext) {
    const form = await this.db.query.signPublicForms.findFirst({ where: eq(signPublicForms.slug, slug) });
    if (!form || form.status !== "published") throw new NotFoundException("Form not found");
    if (form.expiresAt && form.expiresAt.getTime() < Date.now()) throw new NotFoundException("Form not found");
    if (form.maxSubmissions && form.submissionCount >= form.maxSubmissions) throw new ForbiddenException("This form is no longer accepting submissions");
    if (form.accessCodeHash && (!input.accessCode || this.tokens.hash(input.accessCode) !== form.accessCodeHash)) {
      throw new ForbiddenException("Invalid access code");
    }

    const template = await this.templates.get(form.orgId, form.templateId);
    const snapshot = parseTemplateSnapshot(template.templateJson);
    const signingRole = snapshot.roles.find((r) => SIGNING_RECIPIENT_TYPES.includes(r.recipientType));
    if (!signingRole) throw new BadRequestException("This form's template has no signer role configured");

    const envelope = await this.templates.instantiate(form.orgId, form.createdBy ?? template.ownerUserId ?? "", form.templateId, {
      recipients: [{ roleName: signingRole.roleName, name: input.name, email: input.email, phone: input.phone }],
      sourceModule: "public_form",
      sourceEntityId: String(form.id),
    });

    const recipient = await this.db.query.signRecipients.findFirst({ where: eq(signRecipients.envelopeId, envelope.id) });
    if (!recipient) throw new BadRequestException("Failed to create a signer for this submission");

    const orgSettings = await this.settings.getOrCreate(form.orgId);
    const expiresAt = new Date(Date.now() + orgSettings.defaultExpirationDays * 24 * 60 * 60 * 1000);
    const rawToken = this.tokens.generateSigningToken();

    await this.db
      .update(signEnvelopes)
      .set({ status: "sent", sentAt: new Date(), expiresAt })
      .where(eq(signEnvelopes.id, envelope.id));
    await this.db
      .update(signRecipients)
      .set({ status: "invited", signingTokenHash: this.tokens.hash(rawToken), tokenExpiresAt: expiresAt })
      .where(eq(signRecipients.id, recipient.id));
    await this.db
      .update(signPublicForms)
      .set({ submissionCount: form.submissionCount + 1 })
      .where(eq(signPublicForms.id, form.id));

    await this.audit.record({
      orgId: form.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: input.name,
      actorEmail: input.email,
      eventType: "public_form_submitted",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return {
      token: rawToken,
      recipientId: recipient.id,
      envelopeId: envelope.id,
      redirectUrl: form.completionRedirectUrl,
    };
  }

  private async resolveRecipient(token: string) {
    const hash = this.tokens.hash(token);
    const recipient = await this.db.query.signRecipients.findFirst({ where: eq(signRecipients.signingTokenHash, hash) });
    if (!recipient) throw new NotFoundException("This signing link is invalid.");
    const envelope = await this.db.query.signEnvelopes.findFirst({ where: eq(signEnvelopes.id, recipient.envelopeId) });
    if (!envelope) throw new NotFoundException("This signing link is invalid.");
    return { recipient, envelope };
  }

  private deriveState(recipient: typeof signRecipients.$inferSelect, envelope: typeof signEnvelopes.$inferSelect): SessionState {
    if (envelope.status === "voided") return "envelope_voided";
    if (envelope.status === "expired") return "envelope_expired";
    if (envelope.status === "declined") return "envelope_declined";
    if (envelope.status === "completed") return "envelope_completed";
    if (recipient.status === "completed") return "recipient_completed";
    if (recipient.status === "declined") return "recipient_declined";
    if (recipient.tokenRevokedAt) return "revoked";
    if (recipient.tokenExpiresAt && recipient.tokenExpiresAt.getTime() < Date.now()) return "expired";
    if (recipient.status === "pending") return "not_your_turn";
    return "active";
  }

  async getSession(token: string, ctx: PublicRequestContext) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    const state = this.deriveState(recipient, envelope);

    if (state !== "active") {
      return { state, envelopeTitle: envelope.title, recipientName: recipient.name };
    }

    const isFirstView = recipient.status === "invited";
    const isAutoAuthenticated = recipient.authMethod === "email_link";

    const patch: Partial<typeof signRecipients.$inferInsert> = {};
    if (isFirstView) patch.status = "viewed";
    if (!recipient.viewedAt) patch.viewedAt = new Date();
    if (isAutoAuthenticated && !recipient.authenticatedAt) {
      patch.authenticatedAt = new Date();
      patch.status = "authenticated";
    }
    if (Object.keys(patch).length > 0) {
      await this.db.update(signRecipients).set(patch).where(eq(signRecipients.id, recipient.id));
    }

    if (isFirstView) {
      await this.audit.record({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        actorType: "external_signer",
        actorName: recipient.name,
        actorEmail: recipient.email,
        eventType: "signing_link_opened",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    }

    const sender = await this.db.query.users.findFirst({ where: eq(users.id, envelope.senderUserId) });
    const documents = await this.db.query.signDocuments.findMany({
      where: eq(signDocuments.envelopeId, envelope.id),
      orderBy: (d, { asc }) => [asc(d.orderIndex)],
    });
    const fields = await this.db.query.signFields.findMany({
      where: and(eq(signFields.envelopeId, envelope.id), eq(signFields.recipientId, recipient.id)),
      orderBy: (f, { asc }) => [asc(f.pageNumber), asc(f.orderIndex)],
    });

    return {
      state,
      envelope: { id: envelope.id, title: envelope.title, subject: envelope.subject, message: envelope.message, expiresAt: envelope.expiresAt },
      sender: { name: sender?.name ?? "Sender" },
      recipient: {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        authMethod: recipient.authMethod,
        authenticated: Boolean(recipient.authenticatedAt),
        consentAccepted: Boolean(recipient.consentAcceptedAt),
      },
      documents: documents.map((d) => ({ id: d.id, fileName: d.fileName, pageCount: d.pageCount })),
      fields,
    };
  }

  async getDocumentPreview(token: string, documentId: number) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    if (this.deriveState(recipient, envelope) !== "active" && recipient.status !== "completed") {
      throw new ForbiddenException("This document is not currently available.");
    }
    const doc = await this.db.query.signDocuments.findFirst({ where: and(eq(signDocuments.id, documentId), eq(signDocuments.envelopeId, envelope.id)) });
    if (!doc) throw new NotFoundException("Document not found");
    const url = await this.storage.getFileUrl(doc.currentFileKey, SIGNED_URL_EXPIRY_SECONDS);
    return { url, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS };
  }

  private assertActive(recipient: typeof signRecipients.$inferSelect, envelope: typeof signEnvelopes.$inferSelect) {
    const state = this.deriveState(recipient, envelope);
    if (state !== "active") {
      throw new ForbiddenException(`This signing session is no longer active (${state}).`);
    }
  }

  async requestOtp(token: string) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);
    if (recipient.authMethod !== "otp_email") throw new BadRequestException("OTP is not enabled for this recipient");
    if (!recipient.email) throw new BadRequestException("No email on file for OTP delivery");

    const otp = this.tokens.generateOtp();
    await this.db
      .update(signRecipients)
      .set({ otpCodeHash: this.tokens.hash(otp), otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000), otpAttempts: 0 })
      .where(eq(signRecipients.id, recipient.id));

    await this.notifications.sendOtpCode(recipient.email, recipient.name, otp);
    return { sent: true };
  }

  async authenticate(token: string, input: PublicAuthInput, ctx: PublicRequestContext) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);

    if (recipient.authLockedUntil && recipient.authLockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException("Too many failed attempts. Please try again later.");
    }

    let passed: boolean;
    if (recipient.authMethod === "email_link") {
      passed = true;
    } else if (recipient.authMethod === "access_code") {
      passed = Boolean(input.accessCode) && recipient.accessCodeHash === this.tokens.hash(input.accessCode ?? "");
    } else if (recipient.authMethod === "otp_email") {
      passed =
        Boolean(input.otpCode) &&
        recipient.otpCodeHash === this.tokens.hash(input.otpCode ?? "") &&
        Boolean(recipient.otpExpiresAt) &&
        recipient.otpExpiresAt!.getTime() > Date.now();
    } else {
      throw new BadRequestException(`Authentication method "${recipient.authMethod}" is not yet supported for self-serve signing`);
    }

    if (!passed) {
      const attempts = recipient.failedAuthAttempts + 1;
      await this.db
        .update(signRecipients)
        .set({
          failedAuthAttempts: attempts,
          authLockedUntil: attempts >= MAX_AUTH_ATTEMPTS ? new Date(Date.now() + 15 * 60 * 1000) : recipient.authLockedUntil,
        })
        .where(eq(signRecipients.id, recipient.id));

      await this.audit.record({
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

    await this.db
      .update(signRecipients)
      .set({ status: "authenticated", authenticatedAt: new Date(), failedAuthAttempts: 0, authLockedUntil: null })
      .where(eq(signRecipients.id, recipient.id));

    await this.audit.record({
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
  }

  async acceptConsent(token: string, input: PublicConsentInput, ctx: PublicRequestContext) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);
    if (!recipient.authenticatedAt) throw new ForbiddenException("Please complete authentication first");

    await this.db
      .update(signRecipients)
      .set({
        consentAcceptedAt: new Date(),
        consentIp: ctx.ipAddress,
        consentUserAgent: ctx.userAgent,
        consentDisclosureVersion: input.disclosureVersion,
      })
      .where(eq(signRecipients.id, recipient.id));

    await this.audit.record({
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
  }

  async setFieldValue(token: string, fieldId: number, input: PublicFieldValueInput) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);
    if (!recipient.consentAcceptedAt) throw new ForbiddenException("Please accept the electronic signature consent first");

    const field = await this.db.query.signFields.findFirst({ where: and(eq(signFields.id, fieldId), eq(signFields.recipientId, recipient.id)) });
    if (!field) throw new NotFoundException("Field not found");
    if (field.readonly) throw new ForbiddenException("This field is read-only");
    if (field.fieldType === "signature" || field.fieldType === "initials" || field.fieldType === "stamp") {
      throw new BadRequestException("Use the adopt-signature endpoint for this field type");
    }
    if (field.fieldType === "dropdown" || field.fieldType === "radio") {
      if (typeof input.value === "string" && field.optionsJson && !field.optionsJson.includes(input.value)) {
        throw new BadRequestException("Selected value is not one of the allowed options");
      }
    }

    const valueJson = field.fieldType === "checkbox" ? { checked: Boolean(input.value) } : { value: input.value };
    await this.db
      .update(signFields)
      .set({ valueJson, completedAt: input.value ? new Date() : null })
      .where(eq(signFields.id, fieldId));

    return { success: true };
  }

  async adoptSignature(token: string, input: AdoptSignatureInput, ctx: PublicRequestContext) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);
    if (!recipient.consentAcceptedAt) throw new ForbiddenException("Please accept the electronic signature consent first");

    let imageFileKey: string | undefined;
    if (input.imageDataUrl) {
      const base64 = input.imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64, "base64");
      const uploaded = await this.storage.uploadFile(buffer, `signos/${envelope.orgId}/${envelope.id}/signatures`, `${input.assetType}.png`, "image/png");
      imageFileKey = uploaded.key;
    }

    const [asset] = await this.db
      .insert(signSignatureAssets)
      .values({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        assetType: input.assetType,
        method: input.method,
        imageFileKey,
        typedText: input.typedText,
        typedFontStyle: input.typedFontStyle,
      })
      .returning();

    const matchingFields = await this.db.query.signFields.findMany({
      where: and(eq(signFields.recipientId, recipient.id), eq(signFields.fieldType, input.assetType)),
    });
    for (const field of matchingFields) {
      if (field.completedAt) continue;
      await this.db
        .update(signFields)
        .set({ valueJson: { signatureAssetId: asset.id }, completedAt: new Date() })
        .where(eq(signFields.id, field.id));
    }

    await this.audit.record({
      orgId: envelope.orgId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorType: "external_signer",
      actorName: recipient.name,
      actorEmail: recipient.email,
      eventType: "signature_adopted",
      eventMessage: `Adopted ${input.assetType} via ${input.method}`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return asset;
  }

  async complete(token: string, ctx: PublicRequestContext) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);
    if (!recipient.consentAcceptedAt) throw new ForbiddenException("Please accept the electronic signature consent first");

    const fields = await this.db.query.signFields.findMany({ where: eq(signFields.recipientId, recipient.id) });

    for (const field of fields) {
      if (field.fieldType === "date_signed" && !field.completedAt) {
        await this.db
          .update(signFields)
          .set({ valueJson: { value: new Date().toISOString().slice(0, 10) }, completedAt: new Date() })
          .where(eq(signFields.id, field.id));
      }
    }

    const refreshedFields = await this.db.query.signFields.findMany({ where: eq(signFields.recipientId, recipient.id) });
    const incomplete = refreshedFields.filter((f) => f.required && !f.completedAt);
    if (incomplete.length > 0) {
      throw new BadRequestException({
        message: "Please complete all required fields before finishing.",
        fieldIds: incomplete.map((f) => f.id),
      });
    }

    const claimed = await this.db
      .update(signRecipients)
      .set({ status: "completed", completedAt: new Date(), tokenRevokedAt: new Date() })
      .where(and(eq(signRecipients.id, recipient.id), eq(signRecipients.status, "authenticated")))
      .returning();

    if (claimed.length === 0) {
      throw new BadRequestException("This document has already been completed or is no longer active.");
    }

    await this.audit.record({
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

    this.integrations.emitRecipientCompleted(envelope, { id: recipient.id, name: recipient.name, email: recipient.email });

    const outcome = await this.envelopes.applyRecipientOutcome(envelope.orgId, envelope.id);
    if (outcome.becameCompleted) {
      await this.finalization.finalize(envelope.orgId, envelope.id);
    }

    return { completed: true, envelopeCompleted: outcome.becameCompleted };
  }

  async decline(token: string, input: DeclineInput, ctx: PublicRequestContext) {
    const { recipient, envelope } = await this.resolveRecipient(token);
    this.assertActive(recipient, envelope);
    if (!envelope.allowDecline) throw new ForbiddenException("Declining is not permitted for this envelope");

    const claimed = await this.db
      .update(signRecipients)
      .set({ status: "declined", declinedAt: new Date(), declinedReason: input.reason, tokenRevokedAt: new Date() })
      .where(and(eq(signRecipients.id, recipient.id), eq(signRecipients.status, recipient.status)))
      .returning();
    if (claimed.length === 0) throw new BadRequestException("This document is no longer active.");

    await this.audit.record({
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

    await this.envelopes.applyRecipientOutcome(envelope.orgId, envelope.id);

    const sender = await this.db.query.users.findFirst({ where: eq(users.id, envelope.senderUserId) });
    if (sender?.email) {
      await this.notifications.sendDeclinedToSender(sender.email, sender.name ?? "Sender", envelope.id, envelope.title, recipient.name, input.reason);
    }

    return { declined: true };
  }
}
