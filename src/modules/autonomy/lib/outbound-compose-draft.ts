import { redactForModel } from "../decision-record";
import type { OutboundClass } from "../outbound-classes";
import {
  buildOutboundPrompt,
  outboundDraftSchema,
  OUTBOUND_FEATURE,
  OUTBOUND_PROMPT_KEY,
  OUTBOUND_PROMPT_VERSION,
  OUTBOUND_SYSTEM_PROMPT,
  type OutboundDraft,
} from "../outbound-draft";
import type { ComposeContext, OutboundDraftDeps } from "./outbound-compose.types";

/*
  The one provider call compose time makes. `composeAndHold` reaches it only
  after every refusal that needs no provider, and judges what comes back with
  `judgeDraft` before anything is written.
*/

/**
 * Redact what the drafter will be shown, then ask the small model to write.
 *
 * The redacted strings come back with the result because `judgeDraft` checks
 * the draft against exactly what the model was shown.
 */
export async function draftOutboundMessage(
  deps: OutboundDraftDeps,
  organizationId: string,
  context: ComposeContext,
  outboundClass: OutboundClass,
) {
  /**
   * Redacted before the prompt is built, not after.
   *
   * Permission data must never reach a provider and no model output may
   * influence an authorization decision. Nothing assembled here is
   * permission-shaped by construction; this is the line that catches the field
   * somebody adds to `loadComposeContext` later without thinking.
   */
  const { context: safe, removed } = redactForModel({
    recipientName: context.recipientName,
    senderName: context.senderName,
    companyName: context.companyName,
    dealName: context.dealName,
    agreedNextStep: context.agreedNextStep,
    conversation: context.conversation,
  });

  if (removed.length > 0)
    deps.logger.warn(`outbound: stripped ${removed.length} forbidden field(s) before inference`);

  const conversation = (safe.conversation as string) ?? "";
  const recipientName = (safe.recipientName as string) ?? "";
  const senderName = (safe.senderName as string) ?? "";

  const result = await deps.gateway.invokeStructuredWithUsage<OutboundDraft>({
    actor: { orgId: organizationId, userId: null },
    feature: OUTBOUND_FEATURE,
    // Writing four sentences to somebody we already know is the small model's
    // job. Nothing here escalates: a message that needs frontier reasoning is
    // a message that needs a person.
    tier: "fast",
    schema: outboundDraftSchema,
    charge: true,
    prompt: {
      system: OUTBOUND_SYSTEM_PROMPT,
      user: buildOutboundPrompt({
        outboundClass,
        recipientName,
        senderName,
        companyName: (safe.companyName as string | null) ?? null,
        dealName: (safe.dealName as string | null) ?? null,
        agreedNextStep: (safe.agreedNextStep as string | null) ?? null,
        daysSinceLastContact: context.daysSinceLastContact,
        conversation,
      }),
      promptKey: OUTBOUND_PROMPT_KEY,
      promptVersion: OUTBOUND_PROMPT_VERSION,
    },
  });

  return { result, conversation, recipientName, senderName };
}
