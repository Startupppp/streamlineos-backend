import { ConflictException } from "@nestjs/common";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { and, eq } from "drizzle-orm";
import { getOrgAdminUserIds } from "../../../common/tenant/org-admin-recipients";
import { startRun } from "../../../common/workflow/workflow-store";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, crmOutboundMessages, deals } from "../../../db/schema";
import { buildDecision } from "../decision-record";
import { clampHoldWindow } from "../hold-window";
import { decisionKindFor, OUTBOUND_CLASS_LABELS, trackFor, type OutboundClass } from "../outbound-classes";
import { OUTBOUND_PROMPT_VERSION } from "../outbound-draft";
import type { ComposeOutcome, OutboundHoldDeps, OutboundHoldInput } from "./outbound-compose.types";

/*
  Compose time's two writes: the hold — the decision, the message, the hold and
  its workflow run, inside the one tenant transaction `holdOutboundSend` opens
  in `outbound.service.ts` — and the ledger row for a compose that stopped
  before placing one.
*/

/**
 * The name the placer and the runner both use. Declared here, beside the
 * placement, for the reason `HOLD_WORKFLOW` is declared beside `holdQuoteSend`:
 * a run started under one string and handled under another is dead-lettered,
 * and two constants in two files are two things that can drift.
 */
export const OUTBOUND_WORKFLOW = "crm.autonomy-outbound";

/**
 * Write the message down and start its clock.
 *
 * Three rows in one order that is not arbitrary. The ledger row first, because
 * `crm_outbound_messages.autonomous_decision_id` is NOT NULL and the ledger is
 * the record that must exist even if everything after it fails. The message
 * second, because the hold points at it. The hold last, because the moment it
 * exists the window has started and a human may cancel it.
 */
export async function placeOutboundHold(
  deps: OutboundHoldDeps,
  tx: TenantTx,
  input: OutboundHoldInput,
): Promise<ComposeOutcome> {
  const { organizationId, outboundClass, draft } = input;
  const kind = decisionKindFor(outboundClass);
  const settings = await deps.scoring.settingsFor(organizationId);
  const windowSeconds = clampHoldWindow(settings.holdWindowSeconds);
  const holdUntil = new Date(Date.now() + windowSeconds * 1000);

  const [decision] = await (tx as unknown as Db)
    .insert(autonomousDecisions)
    .values(
      buildDecision({
        organizationId,
        kind,
        // Not `applied`: it has not left yet, and the feed must not say it has.
        outcome: "held",
        triggerType: "party",
        triggerId: input.partyId,
        partyId: input.partyId,
        dealId: input.dealId,
        model: input.model,
        promptVersion: String(OUTBOUND_PROMPT_VERSION),
        confidence: draft.confidence,
        inputs: { why: input.reason, outboundClass },
        decision: { outboundClass, holdUntil: holdUntil.toISOString() },
        summary: draft.summary,
      }),
    )
    .returning({ id: autonomousDecisions.autonomousDecisionId });

  if (!decision) throw new ConflictException("Could not record the decision to send.");

  const [message] = await (tx as unknown as Db)
    .insert(crmOutboundMessages)
    .values({
      organizationId,
      partyId: input.partyId,
      contactId: input.contactId,
      dealId: input.dealId,
      outboundClass,
      // Derived, never passed in. `chk_crm_outbound_messages_track` refuses a
      // row whose track disagrees with its class, because a `cold_outreach`
      // filed as `engaged` slips past the cold gate's own daily count.
      track: trackFor(outboundClass),
      subject: draft.subject,
      body: draft.body,
      status: "drafted",
      autonomousDecisionId: decision.id,
      model: input.model,
      promptVersion: String(OUTBOUND_PROMPT_VERSION),
    })
    .returning({ id: crmOutboundMessages.outboundMessageId });

  if (!message) throw new ConflictException("Could not record the drafted message.");

  let hold;
  try {
    [hold] = await (tx as unknown as Db)
      .insert(autonomyHolds)
      .values({
        organizationId,
        autonomousDecisionId: decision.id,
        /**
         * The same value, narrowed rather than re-derived.
         *
         * `decisionKindFor` returns the whole `DecisionKind` union while
         * `autonomy_holds.kind` declares only the three kinds that can wait,
         * and TypeScript cannot see that this class can only produce two of
         * them. Deriving the hold's kind from the track a second time would be
         * a second mapping from class to kind, and two of those are two things
         * that can disagree — which is the failure `outbound-classes.ts`
         * writes `TRACK` as a total map to prevent.
         */
        kind: kind as "outbound.sent" | "cold_outbound.sent",
        outboundMessageId: message.id,
        holdUntil,
      })
      .returning({ id: autonomyHolds.autonomyHoldId });
  } catch (error) {
    // `uniq_autonomy_holds_live_outbound`. A second decision to send the same
    // draft while one is already waiting is a duplicate, not a race to win.
    if (isUniqueViolation(error))
      throw new ConflictException("That message is already waiting to send.");
    throw error;
  }

  if (!hold) throw new ConflictException("Could not place the hold.");

  const runId = await startRun((tx as unknown as Db), {
    organizationId,
    workflowName: OUTBOUND_WORKFLOW,
    input: { autonomyHoldId: hold.id, outboundMessageId: message.id },
    causationEventId: hold.id,
    correlationId: `outbound:${message.id}`,
  });

  await (tx as unknown as Db)
    .update(autonomyHolds)
    .set({ workflowRunId: runId })
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.autonomyHoldId, hold.id),
      ),
    );

  await (tx as unknown as Db)
    .update(crmOutboundMessages)
    .set({ status: "held" })
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.outboundMessageId, message.id),
      ),
    );

  await notifyPending(deps, organizationId, {
    holdId: hold.id,
    dealId: input.dealId,
    subject: draft.subject,
    outboundClass,
    windowSeconds,
  });

  return {
    held: true,
    outboundMessageId: message.id,
    autonomyHoldId: hold.id,
    decisionId: decision.id,
    outboundClass,
    holdUntil,
    windowSeconds,
  };
}

/** The ledger row for a compose that stopped before placing a hold. */
export async function recordOutboundRefusal(
  db: Db,
  organizationId: string,
  input: { partyId: string; dealId?: string | null },
  kind: ReturnType<typeof decisionKindFor>,
  summary: string,
  outcome: "skipped" | "failed" = "skipped",
  extra: { model?: string | null; confidence?: number | null } = {},
): Promise<void> {
  await db.insert(autonomousDecisions).values(
    buildDecision({
      organizationId,
      kind,
      outcome,
      triggerType: "party",
      triggerId: input.partyId,
      partyId: input.partyId,
      dealId: input.dealId ?? null,
      model: extra.model ?? null,
      promptVersion: String(OUTBOUND_PROMPT_VERSION),
      confidence: extra.confidence ?? null,
      summary,
    }),
  );
}

/**
 * Tell somebody who could stop it, while there is still time.
 *
 * A hold nobody hears about is a delay, not a safeguard — and a failed
 * notification must not stop the hold existing, because the review feed still
 * shows it and a throw here would leave a message drafted with no clock.
 */
async function notifyPending(
  deps: OutboundHoldDeps,
  organizationId: string,
  input: {
    holdId: string;
    dealId: string | null;
    subject: string;
    outboundClass: OutboundClass;
    windowSeconds: number;
  },
): Promise<void> {
  const deal = input.dealId ? await loadDealAssignee(deps.db, organizationId, input.dealId) : null;
  const recipients = deal ? [deal] : await getOrgAdminUserIds(deps.db, organizationId);

  if (recipients.length === 0) {
    deps.logger.warn(
      `outbound hold ${input.holdId} has nobody to tell; it will send unannounced`,
    );
    return;
  }

  for (const userId of recipients) {
    try {
      await deps.notifications.create({
        orgId: organizationId,
        userId,
        type: "WARNING",
        // High, because the entire value is that it is read before the window ends.
        priority: "HIGH",
        category: "SYSTEM",
        sourceModule: "crm",
        eventKey: "crm.autonomy.outbound-holding",
        entityType: "autonomy_hold",
        entityId: input.holdId,
        title: `A ${OUTBOUND_CLASS_LABELS[input.outboundClass].toLowerCase()} is about to send`,
        message: `"${input.subject}" sends in ${input.windowSeconds} seconds unless you stop it.`,
        link: `/crm/autonomy?holdId=${input.holdId}`,
      });
    } catch (error) {
      deps.logger.error(
        `could not notify ${userId} about outbound hold ${input.holdId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function loadDealAssignee(db: Db, organizationId: string, dealId: string): Promise<string | null> {
  const numeric = Number(dealId);
  if (!Number.isInteger(numeric)) return null;

  const [row] = await db
    .select({ assignedToId: deals.assignedToId })
    .from(deals)
    .where(and(eq(deals.orgId, organizationId), eq(deals.id, numeric)))
    .limit(1);

  return row?.assignedToId ?? null;
}
