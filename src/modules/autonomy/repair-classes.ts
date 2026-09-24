import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import { REPAIR_CLASSES, type RepairClass } from "../../db/schema/crm/autonomy-repairs";
import { emailFailure, phoneFailure } from "../data-quality/field-checks";
import type { SwitchDecision } from "./kill-switch";

/**
 * Which classes the system may repair unattended, and what one repair would be.
 *
 * Pure, and that is not incidental. This decides whether the product changes a
 * customer's record with nobody watching, so it has to be arguable against a
 * test rather than against a running database — the same reason `kill-switch.ts`
 * and `eligibility.ts` are pure.
 *
 * Two questions live here and they are deliberately separate:
 *
 * `mayRepair` answers *is this class allowed at all, for this tenant, right now*
 * — a policy question, answered from the kill switch and the tenant's grants.
 *
 * `proposeRepair` answers *what would the repair be* — an arithmetic question,
 * answered from the value alone. It refuses far more often than it agrees, and
 * the refusals are the interesting part: every one of them is a case where a
 * person has to choose.
 *
 * Both fail closed. An unknown class is refused rather than defaulted, because
 * "no row, so use the default" is exactly how a capability grows by accident.
 */

/** What one repair class is, and what it is allowed to touch. */
export interface RepairClassDefinition {
  readonly repairClass: RepairClass;
  /** The queue's finding this class can close, by `producer.detail` name. */
  readonly findingKind: string;
  /** The `business_parties` column a repair rewrites. */
  readonly field: "email" | "phone";
  /**
   * In the set a tenant gets without asking.
   *
   * The line is whether the repair can change *which real-world thing the value
   * denotes*. Re-spelling a number in ASCII cannot; deleting a space from a
   * mailbox name can, so that class is a grant rather than a default.
   */
  readonly conservative: boolean;
  /**
   * Always `instant`, and stated per class rather than assumed.
   *
   * It is a property of the action, exactly as in `decision-record.ts`: a
   * repair is one reversing write because the value it replaced was recorded
   * before the write. A class that could not say this would be promising the
   * review feed an undo the ledger cannot perform.
   */
  readonly reversibility: ReversibilityClass;
  /** One sentence a tenant reads on the screen where they grant it. */
  readonly description: string;
}

export const REPAIR_CLASS_DEFINITIONS: Readonly<Record<RepairClass, RepairClassDefinition>> = {
  "email.whitespace": {
    repairClass: "email.whitespace",
    findingKind: "reachability.malformed-email",
    field: "email",
    conservative: false,
    reversibility: "instant",
    description:
      "Delete whitespace from an e-mail address, where the whitespace sits somewhere an address could never contain one. Never where it separates two parts of the name, which could have stood in for a dot.",
  },
  "email.domain-dot-edge": {
    repairClass: "email.domain-dot-edge",
    findingKind: "reachability.malformed-email",
    field: "email",
    conservative: true,
    reversibility: "instant",
    description:
      "Remove a dot from the start or end of an e-mail domain. A domain cannot begin with one, and a trailing dot is the DNS root label, so the address names the same mailbox either way.",
  },
  "phone.non-ascii-characters": {
    repairClass: "phone.non-ascii-characters",
    findingKind: "reachability.malformed-phone",
    field: "phone",
    conservative: true,
    reversibility: "instant",
    description:
      "Rewrite a phone number's fullwidth or Arabic-Indic digits, typographic dashes and non-breaking spaces as their one ASCII equivalent. The digits are unchanged; a number that is merely missing its country code is left alone.",
  },
};

/** The classes a tenant has unless it says otherwise, in enumeration order. */
export const CONSERVATIVE_REPAIR_CLASSES: readonly RepairClass[] = REPAIR_CLASSES.filter(
  (key) => REPAIR_CLASS_DEFINITIONS[key].conservative,
);

export function isRepairClass(value: string): value is RepairClass {
  return REPAIR_CLASSES.some((c) => c === value);
}

/** Which classes could close a finding of this kind. Empty for most of them. */
export function repairClassesForFindingKind(findingKind: string): RepairClass[] {
  return REPAIR_CLASSES.filter((key) => REPAIR_CLASS_DEFINITIONS[key].findingKind === findingKind);
}

// ── May this class be repaired for this tenant ──────────────────────────────

/** One tenant's stored answer for one class. Absence is not one of these. */
export interface RepairPolicyRow {
  readonly repairClass: string;
  readonly enabled: boolean;
}

export interface RepairPolicyContext {
  /**
   * `resolveSwitch(orgId, "field.repaired", …)`.
   *
   * The repair loop is an autonomous action type like any other, so the kill
   * switch that stops the rest of them stops this too — one veto, not a second
   * one that an operator has to remember exists.
   */
  readonly autonomySwitch: SwitchDecision;
  readonly policies: readonly RepairPolicyRow[];
}

export type RepairRefusalReason =
  | "unknown-class"
  | "autonomy-off"
  | "tenant-disabled"
  | "class-not-enabled";

export type RepairPermission =
  | {
      readonly allowed: true;
      readonly decidedBy: "tenant-enabled" | "conservative-default";
      readonly explanation: null;
    }
  | {
      readonly allowed: false;
      readonly decidedBy: "enumeration" | "kill-switch" | "tenant" | "default";
      readonly reason: RepairRefusalReason;
      /** One sentence, written to be recorded as the decision rather than logged. */
      readonly explanation: string;
    };

/**
 * Whether this class may be repaired without asking, and why.
 *
 * The order of the questions is the order of the vetoes, widest first, matching
 * `resolveSwitch`: is this even a thing we repair, has an operator stopped
 * autonomy, has this tenant spoken, and only then the platform default.
 *
 * Every branch returns a sentence. A refusal that is only a `false` becomes a
 * silence in the ledger, and "the system quietly did nothing" is precisely the
 * failure this loop must not have.
 */
export function mayRepair(repairClass: string, context: RepairPolicyContext): RepairPermission {
  if (!isRepairClass(repairClass))
    return {
      allowed: false,
      decidedBy: "enumeration",
      reason: "unknown-class",
      explanation: `${repairClass} is not a class the system repairs; only a person can act on it.`,
    };

  if (!context.autonomySwitch.allowed)
    return {
      allowed: false,
      decidedBy: "kill-switch",
      reason: "autonomy-off",
      explanation: context.autonomySwitch.reason
        ? `Unattended repair is switched off (${context.autonomySwitch.decidedBy}): ${context.autonomySwitch.reason}`
        : `Unattended repair is switched off (${context.autonomySwitch.decidedBy}).`,
    };

  const stated = context.policies.find((row) => row.repairClass === repairClass);

  if (stated)
    return stated.enabled
      ? { allowed: true, decidedBy: "tenant-enabled", explanation: null }
      : {
          allowed: false,
          decidedBy: "tenant",
          reason: "tenant-disabled",
          explanation: `This organisation has turned off unattended repair of ${repairClass}.`,
        };

  return REPAIR_CLASS_DEFINITIONS[repairClass].conservative
    ? { allowed: true, decidedBy: "conservative-default", explanation: null }
    : {
        allowed: false,
        decidedBy: "default",
        reason: "class-not-enabled",
        explanation: `${repairClass} is off unless this organisation grants it, so these are left for a person.`,
      };
}

export interface EffectiveRepairPolicy extends RepairClassDefinition {
  readonly enabled: boolean;
  /** Whether the answer came from the tenant's own row or the platform default. */
  readonly source: "tenant" | "default";
  readonly reason: string | null;
}

/**
 * The whole enumeration with this tenant's answer against each entry.
 *
 * Every class every time, including the ones nobody has touched, because the
 * screen this feeds is where a tenant decides what to grant — and a list that
 * showed only what had been configured would hide exactly the classes they have
 * not yet thought about.
 */
export function effectiveRepairPolicy(
  policies: readonly (RepairPolicyRow & { reason?: string | null })[],
): EffectiveRepairPolicy[] {
  return REPAIR_CLASSES.map((key) => {
    const definition = REPAIR_CLASS_DEFINITIONS[key];
    const stated = policies.find((row) => row.repairClass === key);

    return {
      ...definition,
      enabled: stated ? stated.enabled : definition.conservative,
      source: stated ? ("tenant" as const) : ("default" as const),
      reason: stated?.reason ?? null,
    };
  });
}

// ── What one repair would be ────────────────────────────────────────────────

export type RepairProposalRefusalReason =
  | "unknown-class"
  /** The value is not broken in the way this class fixes. */
  | "not-the-shape"
  /** More than one plausible repair, so none. */
  | "ambiguous"
  /** The repair would leave a value the producer would flag again. */
  | "still-invalid";

export type RepairProposal =
  | { readonly ok: true; readonly next: string }
  | {
      readonly ok: false;
      readonly reason: RepairProposalRefusalReason;
      readonly explanation: string;
    };

const decline = (reason: RepairProposalRefusalReason, explanation: string): RepairProposal => ({
  ok: false,
  reason,
  explanation,
});

/**
 * The single repair this class would make to this value, or a refusal.
 *
 * Takes the value rather than the finding, because the finding records what was
 * true when the sweep ran and the repair has to be computed from what is true
 * now — a value a person has since corrected must not be rewritten from an
 * evidence snapshot.
 */
export function proposeRepair(repairClass: string, current: string): RepairProposal {
  if (!isRepairClass(repairClass))
    return decline("unknown-class", `${repairClass} is not a class the system repairs.`);

  switch (repairClass) {
    case "email.whitespace":
      return repairEmailWhitespace(current);
    case "email.domain-dot-edge":
      return repairEmailDomainDotEdge(current);
    case "phone.non-ascii-characters":
      return repairPhoneNonAscii(current);
  }
}

/** Split on the single `@`, or refuse: anything else is a different problem. */
function splitAddress(current: string): { local: string; domain: string } | null {
  const parts = current.trim().split("@");
  if (parts.length !== 2) return null;

  const [local, domain] = parts;
  if (local === undefined || domain === undefined) return null;

  return { local, domain };
}

function repairEmailWhitespace(current: string): RepairProposal {
  const trimmed = current.trim();
  if (!/\s/.test(trimmed))
    return decline("not-the-shape", "There is no whitespace in this address to remove.");

  const address = splitAddress(trimmed);
  if (!address)
    return decline(
      "not-the-shape",
      "This address does not have exactly one @, which is a different problem and not one with a single answer.",
    );

  /**
   * The refusal that makes this class admissible.
   *
   * A space between two characters of the name could have been a dot, an
   * underscore, or nothing at all — `johnsmith@`, `john.smith@` and
   * `john_smith@` are three different mailboxes and the value cannot say which
   * was meant. Whitespace anywhere else is in a position an address may not
   * contain one at all, so deleting it re-spells the same address.
   */
  if (/\S\s+\S/.test(address.local))
    return decline(
      "ambiguous",
      "The whitespace sits inside the name, where it could have stood in for a dot — that is a choice, not a repair.",
    );

  const next = trimmed.replace(/\s+/g, "");
  const failure = emailFailure(next);
  if (failure)
    return decline(
      "still-invalid",
      `Removing the whitespace would leave an address that ${failure.detail}.`,
    );

  return { ok: true, next };
}

function repairEmailDomainDotEdge(current: string): RepairProposal {
  const trimmed = current.trim();
  const address = splitAddress(trimmed);
  if (!address)
    return decline("not-the-shape", "This address does not have exactly one @.");

  if (!address.domain.startsWith(".") && !address.domain.endsWith("."))
    return decline("not-the-shape", "This domain does not begin or end in a dot.");

  const domain = address.domain.replace(/^\.+/, "").replace(/\.+$/, "");
  const next = `${address.local}@${domain}`;

  const failure = emailFailure(next);
  if (failure)
    return decline(
      "still-invalid",
      `Removing the edge dots would leave an address that ${failure.detail}.`,
    );

  return { ok: true, next };
}

/**
 * Every non-ASCII character this class knows how to rewrite, and its one ASCII
 * equivalent.
 *
 * A closed table rather than a normalisation call, and deliberately: Unicode
 * normalisation folds a great deal more than this and would happily rewrite
 * characters nobody has thought about. Anything absent from this table is a
 * refusal, which is the direction a repair should fail in.
 *
 * The digit ranges are expanded from their block starts so the map stays one
 * literal table rather than a set of arithmetic special cases.
 */
const NON_ASCII_EQUIVALENTS: ReadonlyMap<string, string> = new Map<string, string>([
  // Spaces that are still a space.
  ["\u00a0", " "], // no-break space
  ["\u2007", " "], // figure space
  ["\u2009", " "], // thin space
  ["\u202f", " "], // narrow no-break space
  ["\u3000", " "], // ideographic space
  // Zero-width characters carry nothing at all.
  ["\u200b", ""], // zero-width space
  ["\u200e", ""], // left-to-right mark
  ["\u200f", ""], // right-to-left mark
  ["\ufeff", ""], // zero-width no-break space
  // Every dash a word processor produces in place of a hyphen.
  ["\u2010", "-"], // hyphen
  ["\u2011", "-"], // non-breaking hyphen
  ["\u2012", "-"], // figure dash
  ["\u2013", "-"], // en dash
  ["\u2014", "-"], // em dash
  ["\u2015", "-"], // horizontal bar
  ["\u2212", "-"], // minus sign
  ["\ufe63", "-"], // small hyphen-minus
  ["\uff0d", "-"], // fullwidth hyphen-minus
  // Fullwidth punctuation, from a form filled in a CJK locale.
  ["\uff0b", "+"], // fullwidth plus
  ["\uff08", "("], // fullwidth left parenthesis
  ["\uff09", ")"], // fullwidth right parenthesis
  ["\uff0f", "/"], // fullwidth solidus
  ["\uff0e", "."], // fullwidth full stop
  // Digits: fullwidth, Arabic-Indic, Extended Arabic-Indic, Devanagari, Bengali.
  ...digitRange(0xff10),
  ...digitRange(0x0660),
  ...digitRange(0x06f0),
  ...digitRange(0x0966),
  ...digitRange(0x09e6),
]);

/** The ten codepoints starting at `zero`, mapped onto `0`-`9`. */
function digitRange(zero: number): [string, string][] {
  return Array.from({ length: 10 }, (_, offset): [string, string] => [
    String.fromCodePoint(zero + offset),
    String(offset),
  ]);
}

function repairPhoneNonAscii(current: string): RepairProposal {
  const trimmed = current.trim();

  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(trimmed))
    return decline(
      "not-the-shape",
      "This number is already written in ASCII, so whatever is wrong with it is not a spelling the system can fix.",
    );

  let next = "";
  for (const character of trimmed) {
    if ((character.codePointAt(0) ?? 0) < 0x80) {
      next += character;
      continue;
    }

    const equivalent = NON_ASCII_EQUIVALENTS.get(character);
    if (equivalent === undefined)
      return decline(
        "ambiguous",
        `This number contains ${JSON.stringify(character)}, which has no single ASCII equivalent.`,
      );

    next += equivalent;
  }

  next = next.trim();

  /**
   * Judged by the producer's own check rather than a second one written here.
   *
   * Two validators would eventually disagree, and the direction they would
   * disagree in is a repair writing a value the next sweep immediately files
   * again. This also puts the country-code case on the right side of the line:
   * mapping the script does not add the missing digits, so the check still
   * fails and the finding stays a person's.
   */
  const failure = phoneFailure(next);
  if (failure)
    return decline(
      "ambiguous",
      `Rewriting the characters would leave a number that ${failure.detail}, which is a problem only a person can settle.`,
    );

  return { ok: true, next };
}
