import type {
  DecisionKind,
  DecisionOutcome,
  ReversibilityClass,
} from "../../db/schema/crm/autonomous-decisions";
import { judgeEligibility } from "./eligibility";

/**
 * Deciding, recording, and refusing to send the wrong thing to a provider.
 *
 * Pure, because these are the rules that decide whether the product acts without
 * asking — and something that acts on a customer's record unprompted has to be
 * provably right before it is wired to anything.
 */

/**
 * How reversible each kind of autonomous action is.
 *
 * A property of the action, not of the confidence behind it: advancing a stage
 * is a single reversing write whether the model was sure or not, and a sent
 * quote has left the building however careful the reasoning was.
 */
const REVERSIBILITY: Readonly<Record<DecisionKind, ReversibilityClass>> = {
  "task.extracted": "instant",
  "stage.advanced": "instant",
  "party.created": "instant",
  "activity.logged": "instant",
  "quote.sent": "hold",
};

export function reversibilityFor(kind: DecisionKind): ReversibilityClass {
  return REVERSIBILITY[kind];
}

/**
 * The confidence a decision needs before it is acted on, per kind.
 *
 * Asymmetric on purpose. A wrongly extracted task is a line on a list somebody
 * deletes; a wrongly advanced stage corrupts a forecast that people plan
 * headcount against, and a wrongly sent quote reaches a customer. The threshold
 * rises with what it costs to be wrong, not with how hard the judgement is.
 */
const ACT_THRESHOLD: Readonly<Record<DecisionKind, number>> = {
  "task.extracted": 0.6,
  "activity.logged": 0.6,
  "party.created": 0.7,
  "stage.advanced": 0.85,
  "quote.sent": 0.9,
};

export function actThresholdFor(kind: DecisionKind): number {
  return ACT_THRESHOLD[kind];
}

/**
 * Whether to act, and never a maybe.
 *
 * Below the threshold the system does nothing at all rather than acting
 * tentatively or asking — the PRD's whole position is that the product acts or
 * stays out of the way, and a queue of half-confident suggestions is the
 * "assists rather than acts" behaviour it exists to replace.
 */
export function shouldAct(kind: DecisionKind, confidence: number | null | undefined): boolean {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return false;
  if (confidence < 0 || confidence > 1) return false;
  return confidence >= actThresholdFor(kind);
}

export interface DecisionInput {
  readonly organizationId: string;
  readonly kind: DecisionKind;
  readonly outcome: DecisionOutcome;
  readonly triggerType: string;
  readonly triggerId?: string | null;
  readonly partyId?: string | null;
  readonly dealId?: string | null;
  readonly activityId?: string | null;
  readonly model?: string | null;
  readonly promptVersion?: string | null;
  readonly confidence?: number | null;
  readonly inputs?: Record<string, unknown> | null;
  readonly decision?: Record<string, unknown> | null;
  readonly summary?: string | null;
}

export interface DecisionRow {
  organizationId: string;
  kind: DecisionKind;
  outcome: DecisionOutcome;
  triggerType: string;
  triggerId: string | null;
  partyId: string | null;
  dealId: string | null;
  activityId: string | null;
  model: string | null;
  promptVersion: string | null;
  confidence: number | null;
  inputs: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  summary: string | null;
  reversibility: ReversibilityClass;
}

/**
 * Builds the row, deriving reversibility rather than accepting it.
 *
 * A caller that could pass its own would eventually pass `instant` for something
 * that is not, and the review feed would tell a manager they can undo something
 * they cannot.
 */
export function buildDecision(input: DecisionInput): DecisionRow {
  return {
    organizationId: input.organizationId,
    kind: input.kind,
    outcome: input.outcome,
    triggerType: input.triggerType,
    triggerId: input.triggerId ?? null,
    partyId: input.partyId ?? null,
    dealId: input.dealId ?? null,
    activityId: input.activityId ?? null,
    model: input.model ?? null,
    promptVersion: input.promptVersion ?? null,
    confidence: input.confidence ?? null,
    inputs: input.inputs ?? null,
    decision: input.decision ?? null,
    summary: input.summary?.trim() ? input.summary.trim() : null,
    reversibility: reversibilityFor(input.kind),
  };
}

// ── What must never reach a provider ────────────────────────────────────────

/**
 * Keys whose values are permission data.
 *
 * The platform rule is absolute: permission data — role names, group membership,
 * org hierarchy, grant history — must not egress to a model provider, and no
 * model output may influence an authorization decision. A prompt that quietly
 * includes a role name is how the second rule gets broken by accident, because
 * once it is in the context the model reasons about it.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "role",
  "roles",
  "roleslug",
  "rolename",
  "permission",
  "permissions",
  "permissionkey",
  "scope",
  "scopes",
  "datascope",
  "isorgowner",
  "isadmin",
  "isowner",
  "grant",
  "grants",
  "rolepermissiongrants",
  "membership",
  "memberships",
  "principalgroup",
  "principalgroups",
  "groupmembership",
  "delegation",
  "delegations",
  "moduleownership",
  "accessversion",
  "rbac",
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "secret",
]);

function isForbidden(key: string): boolean {
  return FORBIDDEN_KEYS.has(key.replace(/[_-]/g, "").toLowerCase());
}

export interface RedactionResult {
  readonly context: Record<string, unknown>;
  /** What was removed, so a caller can log that it happened. */
  readonly removed: string[];
}

/**
 * Strips permission-shaped data from a context before it is sent.
 *
 * A denylist rather than an allowlist is normally the weaker choice, and it is
 * used here deliberately: this runs as a last line behind prompts that are
 * already built from explicit projections, so its job is to catch the field
 * somebody adds later without thinking — not to be the only thing standing
 * between the RBAC tables and a provider.
 */
export function redactForModel(context: Record<string, unknown>): RedactionResult {
  const removed: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`));

    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        const here = path ? `${path}.${key}` : key;
        if (isForbidden(key)) {
          removed.push(here);
          continue;
        }
        out[key] = walk(nested, here);
      }
      return out;
    }

    return value;
  };

  return { context: walk(context, "") as Record<string, unknown>, removed };
}

/**
 * Caps what goes into a prompt.
 *
 * The platform's AI rule is hard limits on rows and text length rather than
 * dumping whole entities into a context window. Truncation is marked so a
 * reviewer reading the recorded inputs can tell the model saw less than the
 * record holds.
 */
export function capText(text: string | null | undefined, maxLength: number): string {
  const value = (text ?? "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… [truncated]`;
}

export function capRows<T>(rows: readonly T[], maxRows: number): T[] {
  return rows.slice(0, maxRows);
}

/**
 * How much of a conversation a decision row keeps — and the authority on it.
 *
 * The model reads up to `MAX_BODY_CHARS`; this is what gets written to
 * `autonomous_decisions.inputs` afterwards. The two numbers are deliberately
 * different: the ledger is read by people and by the shadow scorer, and storing
 * four thousand characters of somebody's mail on every decision buys neither of
 * them anything the first five hundred do not.
 *
 * Stated here rather than at the writer because the shadow scorer caps the same
 * field again on the way out, and the two had drifted — the scorer trimmed to
 * two thousand characters of a string that could never exceed five hundred, so
 * its constant read as a limit while being dead code. Whatever this says is what
 * the scorer can ever see, which makes it the only figure that decides anything.
 */
export const RECORDED_CONVERSATION_CHARS = 500;

/**
 * Whether there is anything worth paying a provider for, as a plain yes or no.
 *
 * The platform rule is to short-circuit before any provider call when there is
 * no eligible context, and this is that check for callers holding the pieces of
 * ONE message — a subject and a body, a form's fields — which is why the parts
 * are joined before they are judged. A caller holding a thread asks
 * `judgeEligibility` directly, message by message, because "is this a fragment
 * standing on its own" is a question about the window rather than the text.
 *
 * The rule it used to state — twenty characters — is gone. `eligibility.ts` has
 * the whole reasoning; the short version is that a length written for mail was
 * silently doing the safety work of stopping a two-word fragment advancing a
 * deal, and that job is now done on purpose.
 */
export function hasEligibleContext(parts: ReadonlyArray<string | null | undefined>): boolean {
  return judgeEligibility([parts.filter(Boolean).join("\n\n")]).eligible;
}
