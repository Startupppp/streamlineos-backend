export const RELOCATION_STATES = [
  "ACTIVE_SOURCE",
  "SNAPSHOT",
  "CATCH_UP",
  "READ_ONLY_SOURCE",
  "VERIFY_TARGET",
  "FLIP_PLACEMENT",
  "ACTIVE_TARGET",
  "RETIRE_SOURCE",
  "ROLLED_BACK",
  "FAILED",
] as const;

export type RelocationState = (typeof RELOCATION_STATES)[number];

export const RELOCATION_EVENTS = [
  "BEGIN",
  "SNAPSHOT_DONE",
  "CATCH_UP_DONE",
  "VERIFY_STARTED",
  "VERIFY_DONE",
  "FLIP_DONE",
  "RETIRE_STARTED",
  "ROLLBACK",
  "FAIL",
] as const;

export type RelocationEvent = (typeof RELOCATION_EVENTS)[number];

type TransitionMap = Readonly<
  Record<RelocationState, readonly RelocationState[]>
>;

const TRANSITIONS: TransitionMap = {
  ACTIVE_SOURCE: ["SNAPSHOT", "ROLLED_BACK", "FAILED"],
  SNAPSHOT: ["CATCH_UP", "ROLLED_BACK", "FAILED"],
  CATCH_UP: ["READ_ONLY_SOURCE", "ROLLED_BACK", "FAILED"],
  READ_ONLY_SOURCE: ["VERIFY_TARGET", "ROLLED_BACK", "FAILED"],
  VERIFY_TARGET: ["FLIP_PLACEMENT", "ROLLED_BACK", "FAILED"],
  FLIP_PLACEMENT: ["ACTIVE_TARGET", "FAILED"],
  ACTIVE_TARGET: ["RETIRE_SOURCE", "FAILED"],
  RETIRE_SOURCE: [],
  ROLLED_BACK: [],
  FAILED: [],
};

export type TransitionErrorCode =
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_STATE"
  | "UNKNOWN_EVENT_FOR_STATE";

export class RelocationTransitionError extends Error {
  readonly code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.name = "RelocationTransitionError";
    this.code = code;
  }
}

export type NextStateResult =
  | { readonly ok: true; readonly state: RelocationState }
  | {
      readonly ok: false;
      readonly code: TransitionErrorCode;
      readonly reason: string;
    };

function assertNever(value: never): never {
  throw new Error(`Unhandled relocation variant: ${JSON.stringify(value)}`);
}

function eventToNext(
  current: RelocationState,
  event: RelocationEvent,
): RelocationState | null {
  switch (event) {
    case "BEGIN":
      return current === "ACTIVE_SOURCE" ? "SNAPSHOT" : null;
    case "SNAPSHOT_DONE":
      return current === "SNAPSHOT" ? "CATCH_UP" : null;
    case "CATCH_UP_DONE":
      return current === "CATCH_UP" ? "READ_ONLY_SOURCE" : null;
    case "VERIFY_STARTED":
      return current === "READ_ONLY_SOURCE" ? "VERIFY_TARGET" : null;
    case "VERIFY_DONE":
      return current === "VERIFY_TARGET" ? "FLIP_PLACEMENT" : null;
    case "FLIP_DONE":
      return current === "FLIP_PLACEMENT" ? "ACTIVE_TARGET" : null;
    case "RETIRE_STARTED":
      return current === "ACTIVE_TARGET" ? "RETIRE_SOURCE" : null;
    case "ROLLBACK":
      return canRollback(current) ? "ROLLED_BACK" : null;
    case "FAIL":
      return isTerminal(current) ? null : "FAILED";
    default:
      return assertNever(event);
  }
}

export function nextState(
  current: RelocationState,
  event: RelocationEvent,
): NextStateResult {
  if (isTerminal(current))
    return {
      ok: false,
      code: "TERMINAL_STATE",
      reason: `State ${current} is terminal; no further transitions are permitted.`,
    };

  const next = eventToNext(current, event);
  if (next === null)
    return {
      ok: false,
      code: "UNKNOWN_EVENT_FOR_STATE",
      reason: `Event "${event}" is not valid from state "${current}".`,
    };

  return { ok: true, state: next };
}

export function assertTransitionAllowed(
  current: RelocationState,
  next: RelocationState,
): void {
  const allowed = TRANSITIONS[current];
  if (!(allowed as readonly string[]).includes(next))
    throw new RelocationTransitionError(
      "ILLEGAL_TRANSITION",
      `Cannot move from ${current} to ${next}. Allowed: [${allowed.join(", ") || "none"}].`,
    );
}

export function canRollback(state: RelocationState): boolean {
  switch (state) {
    case "ACTIVE_SOURCE":
    case "SNAPSHOT":
    case "CATCH_UP":
    case "READ_ONLY_SOURCE":
    case "VERIFY_TARGET":
      return true;
    case "FLIP_PLACEMENT":
    case "ACTIVE_TARGET":
    case "RETIRE_SOURCE":
    case "ROLLED_BACK":
    case "FAILED":
      return false;
    default:
      return assertNever(state);
  }
}

export interface RollbackTarget {
  readonly landingState: "ROLLED_BACK";
  readonly compensations: readonly string[];
}

export function rollbackTargetFor(state: RelocationState): RollbackTarget {
  switch (state) {
    case "ACTIVE_SOURCE":
      return { landingState: "ROLLED_BACK", compensations: [] };
    case "SNAPSHOT":
      return {
        landingState: "ROLLED_BACK",
        compensations: ["discard-partial-target-snapshot"],
      };
    case "CATCH_UP":
      return {
        landingState: "ROLLED_BACK",
        compensations: ["halt-catch-up-relay", "discard-target-data"],
      };
    case "READ_ONLY_SOURCE":
      return {
        landingState: "ROLLED_BACK",
        compensations: ["restore-source-writability", "discard-target-data"],
      };
    case "VERIFY_TARGET":
      return {
        landingState: "ROLLED_BACK",
        compensations: ["restore-source-writability", "discard-target-data"],
      };
    case "FLIP_PLACEMENT":
    case "ACTIVE_TARGET":
    case "RETIRE_SOURCE":
    case "ROLLED_BACK":
    case "FAILED":
      throw new RelocationTransitionError(
        "ILLEGAL_TRANSITION",
        `Rollback is not available from state "${state}". ` +
          `Once FLIP_PLACEMENT completes, reverting requires a fresh relocation in the opposite direction.`,
      );
    default:
      return assertNever(state);
  }
}

export function isTerminal(state: RelocationState): boolean {
  switch (state) {
    case "ROLLED_BACK":
    case "FAILED":
      return true;
    case "ACTIVE_SOURCE":
    case "SNAPSHOT":
    case "CATCH_UP":
    case "READ_ONLY_SOURCE":
    case "VERIFY_TARGET":
    case "FLIP_PLACEMENT":
    case "ACTIVE_TARGET":
    case "RETIRE_SOURCE":
      return false;
    default:
      return assertNever(state);
  }
}

export function isResumable(state: RelocationState): boolean {
  return !isTerminal(state);
}

export function resumeFrom(state: RelocationState): RelocationState {
  if (isTerminal(state))
    throw new RelocationTransitionError(
      "TERMINAL_STATE",
      `Cannot resume from terminal state "${state}". Start a new relocation.`,
    );
  return state;
}
