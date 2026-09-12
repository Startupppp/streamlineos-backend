/**
 * Whether a workspace has reached first value, and what is missing if not.
 *
 * Phase 3 ticket 14. The funnel's measure is not signups but **workspaces with
 * real data in them** -- a trial that reflects a sample rather than the
 * prospect's own business does not convert, and counting signups tells you how
 * many people opened the door rather than how many walked through it.
 *
 * So "activated" has to be a definition somebody can argue with, not a flag
 * somebody sets. Everything here is pure: given counts, it answers the question
 * the same way every time, and the definition can be changed in one place when
 * it turns out to be wrong.
 */

export interface WorkspaceSignals {
  /** Parties the tenant owns, excluding anything seeded as a demo. */
  readonly realParties: number;
  /** Deals a person opened, excluding demo rows. */
  readonly realDeals: number;
  /** Activities logged or ingested against a real party. */
  readonly realActivities: number;
  /** Members who have signed in at least once, the tenant's own people. */
  readonly activeMembers: number;
  /** Whether an import has completed successfully. */
  readonly hasCompletedImport: boolean;
  /** Whether a communication channel is connected and delivering. */
  readonly hasConnectedChannel: boolean;
}

export type ActivationStep =
  | "invite-a-colleague"
  | "bring-your-data"
  | "connect-a-channel"
  | "open-a-deal";

export interface Activation {
  readonly isActivated: boolean;
  /** What the workspace has already done, for a progress surface. */
  readonly completed: readonly ActivationStep[];
  /** What is left, in the order worth doing it. */
  readonly remaining: readonly ActivationStep[];
  /** 0-100, for a bar. Derived, never stored. */
  readonly percent: number;
}

/**
 * The threshold for "real data".
 *
 * More than a handful, because one party created while clicking around is
 * exploration rather than adoption; low enough that a small team importing a
 * genuine book of business clears it immediately.
 */
const REAL_DATA_THRESHOLD = 10;

/**
 * The order steps are worth doing, not the order they are listed.
 *
 * Data first: every other step is more valuable once there is something to do it
 * to, and a colleague invited into an empty workspace sees an empty workspace.
 */
const STEP_ORDER: readonly ActivationStep[] = [
  "bring-your-data",
  "open-a-deal",
  "connect-a-channel",
  "invite-a-colleague",
];

function completedSteps(signals: WorkspaceSignals): Set<ActivationStep> {
  const done = new Set<ActivationStep>();

  // An import counts however few rows it brought: the tenant did the work of
  // pointing us at their data, and penalising a small business for being small
  // would make the measure say something other than what it means.
  if (signals.hasCompletedImport || signals.realParties >= REAL_DATA_THRESHOLD)
    done.add("bring-your-data");

  if (signals.realDeals > 0) done.add("open-a-deal");
  if (signals.hasConnectedChannel || signals.realActivities > 0) done.add("connect-a-channel");
  if (signals.activeMembers > 1) done.add("invite-a-colleague");

  return done;
}

/**
 * A workspace is activated when it holds the tenant's own data **and** somebody
 * has done something with it.
 *
 * Data alone is an import nobody looked at; activity alone is somebody clicking
 * around a demo. Requiring both is what makes this a measure of adoption rather
 * than of effort.
 */
export function activation(signals: WorkspaceSignals): Activation {
  const done = completedSteps(signals);
  const completed = STEP_ORDER.filter((step) => done.has(step));
  const remaining = STEP_ORDER.filter((step) => !done.has(step));

  return {
    isActivated: done.has("bring-your-data") && (done.has("open-a-deal") || done.has("connect-a-channel")),
    completed,
    remaining,
    percent: Math.round((completed.length / STEP_ORDER.length) * 100),
  };
}

/** What to put in front of somebody next. Null when there is nothing left. */
export function nextStep(signals: WorkspaceSignals): ActivationStep | null {
  return activation(signals).remaining[0] ?? null;
}

export const STEP_PROMPTS: Readonly<Record<ActivationStep, string>> = {
  "bring-your-data": "Import your customers, so the trial reflects your business rather than a sample.",
  "open-a-deal": "Open a deal you are actually working, and watch the pipeline maintain itself.",
  "connect-a-channel": "Connect your email, so conversations reach the record without anybody logging them.",
  "invite-a-colleague": "Invite someone who works these deals with you.",
};
