export type SignSessionState =
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

export type SignEnvelopeStatus =
  | "draft"
  | "ready_to_send"
  | "sent"
  | "delivered"
  | "partially_completed"
  | "completed"
  | "declined"
  | "voided"
  | "expired"
  | "correction_required"
  | "failed";

export type SignRecipientStatus =
  | "pending"
  | "invited"
  | "viewed"
  | "authenticated"
  | "signing"
  | "completed"
  | "declined"
  | "delegated"
  | "bounced"
  | "expired";

// Pure, dependency-free so the transition rules can be unit tested without a database.
export const ENVELOPE_TRANSITIONS: Record<SignEnvelopeStatus, SignEnvelopeStatus[]> = {
  draft: ["ready_to_send", "sent", "voided"],
  ready_to_send: ["sent", "draft", "voided"],
  sent: ["delivered", "partially_completed", "completed", "declined", "voided", "expired", "correction_required", "failed"],
  delivered: ["partially_completed", "completed", "declined", "voided", "expired", "correction_required", "failed"],
  partially_completed: ["completed", "declined", "voided", "expired", "correction_required", "failed"],
  correction_required: ["sent", "voided"],
  declined: ["correction_required"],
  expired: ["sent", "correction_required"],
  failed: ["sent", "partially_completed"],
  completed: [],
  voided: [],
};

export const RECIPIENT_TRANSITIONS: Record<SignRecipientStatus, SignRecipientStatus[]> = {
  pending: ["invited", "delegated"],
  invited: ["viewed", "bounced", "expired", "delegated"],
  viewed: ["authenticated", "expired", "bounced"],
  authenticated: ["signing", "expired"],
  signing: ["completed", "declined", "expired"],
  bounced: ["invited"],
  expired: ["invited"],
  completed: [],
  declined: [],
  delegated: [],
};

export const ENVELOPE_TERMINAL_STATUSES: ReadonlySet<SignEnvelopeStatus> = new Set(["completed", "voided"]);

export const ENVELOPE_EDITABLE_STATUSES: ReadonlySet<SignEnvelopeStatus> = new Set(["draft", "ready_to_send"]);

export const ENVELOPE_SIGNABLE_STATUSES: ReadonlySet<SignEnvelopeStatus> = new Set([
  "sent",
  "delivered",
  "partially_completed",
]);

export function canTransitionEnvelope(from: SignEnvelopeStatus, to: SignEnvelopeStatus): boolean {
  if (from === to) return false;
  return ENVELOPE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionRecipient(from: SignRecipientStatus, to: SignRecipientStatus): boolean {
  if (from === to) return false;
  return RECIPIENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isEnvelopeEditable(status: SignEnvelopeStatus): boolean {
  return ENVELOPE_EDITABLE_STATUSES.has(status);
}

export function isEnvelopeTerminal(status: SignEnvelopeStatus): boolean {
  return ENVELOPE_TERMINAL_STATUSES.has(status);
}

export function isEnvelopeSignable(status: SignEnvelopeStatus): boolean {
  return ENVELOPE_SIGNABLE_STATUSES.has(status);
}

/**
 * Given the routing mode and the recipient roster's completion state, decide what the
 * envelope's aggregate status should become next. Pure function — no DB access — so callers
 * pass in exactly the recipient rows relevant to the decision (signers/approvers only; cc/viewer
 * rows never block completion).
 */
export function computeEnvelopeStatusFromRecipients(
  blockingRecipients: { status: SignRecipientStatus }[],
  currentStatus: SignEnvelopeStatus,
): SignEnvelopeStatus {
  if (blockingRecipients.length === 0) return currentStatus;
  if (blockingRecipients.some((r) => r.status === "declined")) return "declined";
  const allCompleted = blockingRecipients.every((r) => r.status === "completed");
  if (allCompleted) return "completed";
  const anyCompleted = blockingRecipients.some((r) => r.status === "completed");
  return anyCompleted ? "partially_completed" : currentStatus;
}

/**
 * Sequential/mixed routing: everyone sharing the lowest routingOrder among not-yet-decided
 * recipients may act next (this collapses to "everyone" for pure parallel routing, a single
 * recipient for pure sequential routing, and grouped batches for mixed routing).
 */
export function nextEligibleRecipientIds(
  recipients: { id: number; routingOrder: number; status: SignRecipientStatus }[],
): number[] {
  const pending = recipients.filter(
    (r) => r.status !== "completed" && r.status !== "declined" && r.status !== "delegated",
  );
  if (pending.length === 0) return [];
  const lowestOrder = Math.min(...pending.map((r) => r.routingOrder));
  return pending.filter((r) => r.routingOrder === lowestOrder).map((r) => r.id);
}
