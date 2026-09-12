import type { Logger } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import type { EmailOutboxService } from "../../email/email-outbox.service";
import type { OutboundClass } from "../outbound-classes";
import type { OutboundService } from "../outbound.service";

/*
  The shapes the step bodies of `OutboundWorkflow` share. The step names, their
  order and the transactions around them stay in `outbound.workflow.ts`; these
  are what `outbound-claim.ts`, `outbound-perform-send.ts` and
  `outbound-hold-state.ts` are handed and hand back.
*/

/**
 * What every step body reads and writes through.
 *
 * The workflow's own injected handles, passed through unchanged, so a query
 * here runs against exactly what the same query ran against when it was a
 * method on the class.
 */
export interface OutboundSendDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly outbound: Pick<
    OutboundService,
    "switchAllows" | "resolveRecipient" | "sendTimeFacts" | "coldTrackFacts" | "pauseColdTrack"
  >;
  readonly outbox: Pick<EmailOutboxService, "enqueueAndTry">;
}

export interface LoadedHold {
  status: "held" | "sent" | "cancelled" | "failed";
  holdUntil: Date;
  decisionId: string;
  outboundMessageId: string;
  partyId: string;
  contactId: number | null;
  dealId: string | null;
  outboundClass: OutboundClass;
  subject: string;
  body: string;
  draftedAt: Date;
  workingHourDeferrals: number;
}

/**
 * The claim step's memo, and therefore JSON.
 *
 * Every field is a primitive because a recorded step is replayed out of
 * `workflow_steps.output` — a `Date` here would come back as a string on the
 * second attempt and the difference would show up as an arithmetic error days
 * later. `waitMs` rather than a `notBefore` instant for exactly that reason.
 */
export type ClaimResult = {
  outcome: string;
  waitMs: number;
  outboundMessageId: string | null;
  decisionId: string | null;
  recipientEmail: string | null;
  subject: string | null;
  body: string | null;
};

/** The claimed message, as `perform-send` receives it from the claim's memo. */
export interface SendTarget {
  outboundMessageId: string;
  decisionId: string;
  recipientEmail: string;
  subject: string;
  body: string;
}
