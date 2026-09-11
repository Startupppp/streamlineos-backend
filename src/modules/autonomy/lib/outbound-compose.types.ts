import type { Logger } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { EmailSuppressionService } from "../../email/email-suppression.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { AutonomyScoringService } from "../autonomy-scoring.service";
import type { OutboundClass } from "../outbound-classes";
import type { OutboundDraft } from "../outbound-draft";
import type { RelationshipSnapshot } from "../outbound-eligibility";

/*
  The shapes `OutboundService` and its lib files share. `ComposeOutcome` is
  re-exported from `outbound.service.ts`, which is where its callers import it.
*/

/** The provider call at compose time, and where it reports a redaction. */
export interface OutboundDraftDeps {
  readonly gateway: Pick<AiGatewayService, "invokeStructuredWithUsage">;
  readonly logger: Logger;
}

/** The send-time read: the service's handle, and the platform suppression list. */
export interface OutboundFactsDeps {
  readonly db: Db;
  readonly suppression: Pick<EmailSuppressionService, "findSuppressed">;
}

/** Placing a hold: the service's handle, the hold window, and who hears about it. */
export interface OutboundHoldDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly scoring: Pick<AutonomyScoringService, "settingsFor">;
  readonly notifications: Pick<NotificationsService, "create">;
}

/** A draft that cleared every compose-time gate, on its way to being held. */
export interface OutboundHoldInput {
  organizationId: string;
  partyId: string;
  dealId: string | null;
  contactId: number | null;
  outboundClass: OutboundClass;
  draft: OutboundDraft;
  model: string | null;
  reason: string;
}

/** The message whose send-time facts are read, as the claim step knows it. */
export interface SendTimeMessage {
  outboundMessageId: string;
  partyId: string;
  contactId: number | null;
  dealId: string | null;
  outboundClass: OutboundClass;
  draftedAt: Date;
  workingHourDeferrals: number;
  recipientEmail: string | null;
}

export type ComposeOutcome =
  | {
      readonly held: false;
      /** Where it stopped, so a caller can tell a refusal from an outage. */
      readonly stage: "eligibility" | "draft" | "confidence";
      readonly reason: string;
    }
  | {
      readonly held: true;
      readonly outboundMessageId: string;
      readonly autonomyHoldId: string;
      readonly decisionId: string;
      readonly outboundClass: OutboundClass;
      readonly holdUntil: Date;
      readonly windowSeconds: number;
    };

export interface ComposeContext {
  readonly snapshot: RelationshipSnapshot;
  readonly contactId: number | null;
  readonly recipientName: string;
  readonly senderName: string;
  readonly companyName: string | null;
  readonly dealName: string | null;
  readonly agreedNextStep: string | null;
  readonly daysSinceLastContact: number | null;
  readonly conversation: string;
}
