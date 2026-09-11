import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers, signDocuments, signEnvelopes, signFields, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { SignFinalizationService } from "./sign-finalization.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SMS_SENDER, type SmsSenderPort } from "./sms/sms-sender.port";
import type { SignSessionState } from "./sign-state";
import type {
  PublicAuthInput,
  PublicConsentInput,
  PublicFieldValueInput,
  AdoptSignatureInput,
  DeclineInput,
} from "./dto/e-sign-public.schemas";
import { withRecipientSession, type PublicRequestContext } from "./lib/recipient-session";
import {
  acceptConsent,
  authenticate,
  requestOtp,
  type RecipientIdentityDeps,
} from "./lib/recipient-identity";
import {
  complete,
  decline,
  type RecipientOutcomeDeps,
} from "./lib/recipient-outcome";
import {
  adoptSignature,
  setFieldValue,
  type RecipientInputDeps,
} from "./lib/recipient-input";

export type { PublicRequestContext };

const SIGNED_URL_EXPIRY_SECONDS = 900;

type SessionRecipient = Pick<typeof signRecipients.$inferSelect, "status" | "tokenRevokedAt" | "tokenExpiresAt">;

@Injectable()
export class SignPublicService {
  private readonly logger = new Logger(SignPublicService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly envelopes: SignEnvelopesService,
    private readonly finalization: SignFinalizationService,
    private readonly notifications: SignNotificationsService,
    private readonly integrations: SignIntegrationsService,
    @Inject(SMS_SENDER) private readonly sms: SmsSenderPort,
  ) {}

  private deriveState(recipient: SessionRecipient, envelope: typeof signEnvelopes.$inferSelect): SignSessionState {
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
    return withRecipientSession(this.db, this.tokens, this.logger, token, async ({ recipient, envelope }) => {
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

      const senderMember =
        envelope.senderMembershipId != null
          ? await this.db.query.organizationMembers.findFirst({
              where: and(eq(organizationMembers.orgId, envelope.orgId), eq(organizationMembers.id, envelope.senderMembershipId)),
              with: { user: { columns: { name: true } } },
            })
          : null;
      const senderName = senderMember?.user?.name ?? "Sender";
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
        sender: { name: senderName },
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
    });
  }

  async getDocumentPreview(token: string, documentId: number) {
    return withRecipientSession(this.db, this.tokens, this.logger, token, async ({ recipient, envelope }) => {
      if (this.deriveState(recipient, envelope) !== "active" && recipient.status !== "completed") {
        throw new ForbiddenException("This document is not currently available.");
      }
      if (!recipient.authenticatedAt)
        throw new ForbiddenException("Please complete authentication first");
      const doc = await this.db.query.signDocuments.findFirst({ where: and(eq(signDocuments.id, documentId), eq(signDocuments.envelopeId, envelope.id)) });
      if (!doc) throw new NotFoundException("Document not found");
      const url = await this.storage.getFileUrl(envelope.orgId, doc.currentFileKey, SIGNED_URL_EXPIRY_SECONDS, undefined, {
        preauthorized: true,
      });
      return { url, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS };
    });
  }

  private assertActive(recipient: SessionRecipient, envelope: typeof signEnvelopes.$inferSelect) {
    const state = this.deriveState(recipient, envelope);
    if (state !== "active")
      throw new ForbiddenException(`This signing session is no longer active (${state}).`);
  }

  requestOtp(token: string) {
    return requestOtp(this.identityDeps, token);
  }

  authenticate(token: string, input: PublicAuthInput, ctx: PublicRequestContext) {
    return authenticate(this.identityDeps, token, input, ctx);
  }

  acceptConsent(token: string, input: PublicConsentInput, ctx: PublicRequestContext) {
    return acceptConsent(this.identityDeps, token, input, ctx);
  }

  setFieldValue(token: string, fieldId: number, input: PublicFieldValueInput) {
    return setFieldValue(this.inputDeps, token, fieldId, input);
  }

  adoptSignature(token: string, input: AdoptSignatureInput, ctx: PublicRequestContext) {
    return adoptSignature(this.inputDeps, token, input, ctx);
  }
  complete(token: string, ctx: PublicRequestContext) {
    return complete(this.outcomeDeps, token, ctx);
  }

  decline(token: string, input: DeclineInput, ctx: PublicRequestContext) {
    return decline(this.outcomeDeps, token, input, ctx);
  }

  private get identityDeps(): RecipientIdentityDeps {
    return {
      db: this.db,
      logger: this.logger,
      tokens: this.tokens,
      audit: this.audit,
      notifications: this.notifications,
      sms: this.sms,
      assertActive: (recipient, envelope) => this.assertActive(recipient, envelope),
    };
  }

  private get inputDeps(): RecipientInputDeps {
    return {
      db: this.db,
      logger: this.logger,
      tokens: this.tokens,
      audit: this.audit,
      storage: this.storage,
      assertActive: (recipient, envelope) => this.assertActive(recipient, envelope),
    };
  }

  private get outcomeDeps(): RecipientOutcomeDeps {
    return {
      db: this.db,
      logger: this.logger,
      tokens: this.tokens,
      audit: this.audit,
      envelopes: this.envelopes,
      finalization: this.finalization,
      notifications: this.notifications,
      integrations: this.integrations,
      assertActive: (recipient, envelope) => this.assertActive(recipient, envelope),
    };
  }
}