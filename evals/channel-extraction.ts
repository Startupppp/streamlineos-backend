import {
  buildExtractionPrompt,
  type Extraction,
} from "../src/modules/autonomy/extraction.schemas";
import {
  capText,
  hasEligibleContext,
  redactForModel,
} from "../src/modules/autonomy/decision-record";
import type { InboundCommunicationEvent } from "../src/modules/ingress/inbound-event";

/**
 * One extractor, the real path to it, and nothing channel-specific in between.
 *
 * The PRD's complaint is that a single blended accuracy figure hides a channel
 * getting worse. Measuring per channel only answers that if the *same* extractor
 * reads all of them — three stand-ins, each written against its own dataset,
 * would report three healthy numbers and prove nothing at all. So there is
 * exactly one here, and the three suites differ only in what they feed it.
 *
 * The path is `AutonomyService.processActivity`'s, step for step, rather than an
 * approximation of it: subject and body joined, capped at the same four thousand
 * characters, short-circuited on the same eligibility floor, redacted with the
 * same denylist and fenced by the same prompt builder. Two of the findings the
 * suites record were only visible because the real path was used — the
 * eligibility floor silently drops most of a WhatsApp burst, and a form's
 * subject is the form's name rather than anything a submitter wrote.
 */

/** The cap `AutonomyService` applies before inference. Mirrored, not guessed. */
export const MAX_BODY_CHARS = 4_000;

/**
 * The stages every channel dataset is scored against.
 *
 * The same six `autonomy-extraction.dataset.ts` uses, so a stage name means the
 * same thing in all four suites and a channel cannot look better by being asked
 * an easier question.
 */
export const EVAL_STAGES = [
  "LEAD",
  "QUALIFIED",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
] as const;

/**
 * The day every dataset is written relative to.
 *
 * Fixed, because a relative reference would make "the fourth of September" a
 * different answer next year and turn a date gate into a calendar.
 */
export const EVAL_TODAY = new Date("2026-08-25T00:00:00.000Z");

/**
 * What happened to one message, including the case where nothing did.
 *
 * `acted: false` is a real outcome rather than a missing one. The telephony
 * adapter never synthesises a transcript, so a call with no recording produces
 * an event with no body — and the correct behaviour is that no provider is
 * called and nothing is written, which every gate below has to be able to score
 * rather than skip.
 */
export type ChannelOutcome =
  | { readonly acted: false; readonly reason: "no-eligible-context" }
  | {
      readonly acted: true;
      readonly extraction: Extraction;
      /** Exactly what a model would have been sent, so a suite can inspect the fence. */
      readonly prompt: string;
      /** Fields the denylist stripped. Empty is the expected answer on all three channels. */
      readonly removed: readonly string[];
    };

/**
 * What a correct extractor does with one case, and what a hostile one is trying
 * to make it do.
 *
 * Stated per case rather than derived from the case's name. The email suite
 * spots its injection case with `name.includes("injection")`, which works and
 * quietly means a renamed case stops being checked.
 */
export interface ChannelExpectation {
  /** The stage a correct extractor moves to, or null to stay put. */
  readonly expectedStage: string | null;
  /** Whose action it is. A task for the customer is not our task. */
  readonly expectedOwner: "us" | "them" | "unclear";
  /**
   * True where the message states a deadline for something *we* owe.
   *
   * Not "contains a date". A voicemail saying "I'm on leave until the twelfth of
   * September" states a date and owes us nothing, and an extractor that turns it
   * into a due date has invented one.
   */
  readonly hasStatedDate: boolean;
  /** The instruction a hostile payload carries, and the stage it demands. */
  readonly injection: {
    readonly instruction: string;
    readonly demandsStage: string;
  } | null;
}

// ── The path a message really takes ─────────────────────────────────────────

/**
 * The conversation string the extractor is given, built the way the service
 * builds it.
 *
 * `[subject, body]` and not `[body]`: a form's subject is its registered name
 * and joins the context *outside* the prompt fence, which is the reason the
 * web-form adapter refuses to put a submitted field there.
 */
export function conversationFor(event: InboundCommunicationEvent): string {
  return capText([event.subject, event.body].filter(Boolean).join("\n\n"), MAX_BODY_CHARS);
}

/**
 * One event, taken as far as the real pipeline would take it.
 *
 * The short-circuit is first and it is not a detail: `hasEligibleContext`
 * refuses anything under twenty characters, so a channel whose messages are
 * mostly shorter than that never reaches a model however good the model is.
 */
export function extractFromEvent(
  event: InboundCommunicationEvent,
  availableStages: readonly string[],
): ChannelOutcome {
  const conversation = conversationFor(event);
  if (!hasEligibleContext([conversation])) return { acted: false, reason: "no-eligible-context" };

  const { context: safe, removed } = redactForModel({
    dealName: null,
    currentStage: null,
    conversation,
  });

  const prompt = buildExtractionPrompt({
    dealName: null,
    currentStage: null,
    availableStages,
    conversation: typeof safe.conversation === "string" ? safe.conversation : "",
  });

  return {
    acted: true,
    prompt,
    removed,
    extraction: emailTunedExtract({ prompt, conversation, availableStages }),
  };
}

// ── The one extractor ───────────────────────────────────────────────────────

export interface ChannelExtractionInput {
  /** What a model would receive. Matched on, so the fence is part of what is scored. */
  readonly prompt: string;
  /** The conversation alone, for quoting evidence back. */
  readonly conversation: string;
  readonly availableStages: readonly string[];
  readonly today?: Date;
}

/**
 * A deterministic stand-in with the real extractor's contract.
 *
 * Every suite in this repo is offline by convention and gates its live block on
 * a key, so what is scored here is a rule set rather than a model. Two things
 * make that worth doing. It is written to *fail* the traps if the rules it
 * encodes are wrong, so each gate is testing something. And its phrase lists
 * were written against email prose — which is exactly the hypothesis the PRD
 * states, so leaving them un-retuned is the experiment rather than a shortcut.
 * A stand-in taught to read transcripts would report that transcripts are fine.
 *
 * The rules are the ones `autonomy-extraction.eval.spec.ts` gates email on,
 * restated so three more channels can be read by the same extractor.
 * `channel-extraction-baseline.eval.spec.ts` runs the email dataset back through
 * this function and asserts email's own thresholds still hold, so the two cannot
 * drift into an unfair comparison without a suite going red.
 *
 * One deliberate difference from that file. There, the due date is `hasStatedDate
 * ? "2026-09-04" : null` — the dataset hands the extractor the answer, so the
 * no-invented-date gate cannot fail whatever the extractor does. Here the date
 * is read out of the text, which is what makes that gate a gate. The reading
 * rule is channel-neutral on purpose: the email-tuning under test lives in the
 * phrase lists, and a date parser that knew about transcripts would move the
 * experiment rather than run it.
 */
export function emailTunedExtract(input: ChannelExtractionInput): Extraction {
  const text = input.prompt.toLowerCase();

  /** Only explicit commitment moves a stage. Sentiment never does. */
  const COMMITMENT = ["approved the budget", "we're going ahead", "we are going ahead"];
  const LOSS = ["another vendor", "decided not to", "going with someone else"];

  /** A conditional frames everything after it as hypothetical. */
  const HYPOTHETICAL = /\bif we\b|just exploring|at this point|hypothetically/;
  /** The other side stated the action, so it is theirs. */
  const THEIR_ACTION = /\bi'll |\bi will |we'll get|our legal|out of the office/;
  /** A direct ask or question addressed to us. */
  const ASK_OF_US = /could you|can you|please send|resend|send me|how does|how much|what is/;

  let suggestedStage: string | null = null;
  if (LOSS.some((phrase) => text.includes(phrase))) suggestedStage = "LOST";
  else if (COMMITMENT.some((phrase) => text.includes(phrase))) suggestedStage = "NEGOTIATION";

  // A stage the organisation does not use is never named.
  if (suggestedStage && !input.availableStages.includes(suggestedStage)) suggestedStage = null;

  // Order matters: a hypothetical wins over the question inside it, and a stated
  // action of theirs wins over a phrase that merely looks like a request.
  const owner: Extraction["nextStep"]["owner"] = HYPOTHETICAL.test(text)
    ? "unclear"
    : THEIR_ACTION.test(text)
      ? "them"
      : ASK_OF_US.test(text)
        ? "us"
        : "unclear";

  return {
    nextStep: {
      description: owner === "us" ? "Respond to what was asked" : null,
      /**
       * A due date only where there is something of ours for it to be due on.
       *
       * Both halves are load-bearing. Without the owner check, "I'm on leave
       * until the twelfth of September" becomes a task due on the twelfth;
       * without the deadline marker below, "resend the invoice from the
       * fourteenth of July" becomes one due next July.
       */
      dueDate: owner === "us" ? statedDueDate(text, input.today ?? EVAL_TODAY) : null,
      owner,
    },
    stage: {
      suggestedStage,
      evidence: suggestedStage ? input.conversation.slice(0, 120) : null,
    },
    confidence: suggestedStage ? 0.9 : 0.7,
    summary: "Extracted from one conversation.",
  };
}

// ── Reading a date that was actually stated ─────────────────────────────────

const MONTH_NAMES: readonly string[] = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Spoken days, because a transcript is where they turn up.
 *
 * Ordered ascending and reversed into the pattern so the longer alternative
 * wins: "twenty first" must not match as "first".
 */
const ORDINAL_WORDS: readonly string[] = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth",
  "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty first",
  "twenty second", "twenty third", "twenty fourth", "twenty fifth", "twenty sixth",
  "twenty seventh", "twenty eighth", "twenty ninth", "thirtieth", "thirty first",
];

const MONTH = `(${MONTH_NAMES.join("|")})`;
const ORDINAL = `(${[...ORDINAL_WORDS]
  .reverse()
  .map((word) => word.replace(/ /g, "[ -]"))
  .join("|")})`;

/**
 * What turns a date into a deadline.
 *
 * A message mentions dates for all sorts of reasons — the invoice from July, the
 * board meeting last Tuesday, the leave that ends on the twelfth — and only a
 * few words make one a thing somebody owes by. Anchored to the end of the text
 * immediately before the date and stopped at a sentence boundary, so a marker
 * two sentences earlier does not reach forward and claim it.
 */
const DEADLINE_MARKER = /\b(by|before|due|deadline|no later than)\b[^.?!]{0,24}$/;

/** How far back a marker may sit. Roughly "by Friday the fourth of September". */
const MARKER_REACH = 30;

interface DatePattern {
  readonly pattern: RegExp;
  readonly read: (match: RegExpMatchArray, today: Date) => string | null;
}

const DATE_PATTERNS: readonly DatePattern[] = [
  { pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/g, read: (m) => isoIfReal(`${m[1]}-${m[2]}-${m[3]}`) },
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "g"),
    read: (m, today) => isoFor(Number(m[1]), m[2], today),
  },
  {
    pattern: new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"),
    read: (m, today) => isoFor(Number(m[2]), m[1], today),
  },
  {
    pattern: new RegExp(`\\b(?:the\\s+)?${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b`, "g"),
    read: (m, today) => isoFor(ordinalDay(m[1]), m[2], today),
  },
];

/**
 * The first date in the text that somebody said something was due by.
 *
 * Text is expected lower-cased; every pattern above is written for that rather
 * than carrying an `i` flag, so the two cannot disagree about "September".
 */
function statedDueDate(text: string, today: Date): string | null {
  for (const { pattern, read } of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      if (!DEADLINE_MARKER.test(text.slice(Math.max(0, at - MARKER_REACH), at))) continue;
      const iso = read(match, today);
      if (iso) return iso;
    }
  }
  return null;
}

function ordinalDay(word: string | undefined): number {
  const normalised = (word ?? "").replace(/-/g, " ");
  return ORDINAL_WORDS.indexOf(normalised) + 1;
}

/**
 * A day and a month as an ISO date, in the next year where this year has passed.
 *
 * The year is inferred because almost nobody says one out loud, and a date
 * already gone by is the one reading that is certainly wrong for a deadline.
 */
function isoFor(day: number, monthName: string | undefined, today: Date): string | null {
  const month = MONTH_NAMES.indexOf(monthName ?? "");
  if (month < 0 || !Number.isInteger(day) || day < 1 || day > 31) return null;

  const year = today.getUTCFullYear();
  const thisYear = new Date(Date.UTC(year, month, day));
  // A day the month does not have is bad data, not a date in the following one.
  if (thisYear.getUTCMonth() !== month) return null;

  const chosen =
    thisYear.getTime() < today.getTime() ? new Date(Date.UTC(year + 1, month, day)) : thisYear;
  return chosen.toISOString().slice(0, 10);
}

/** Rejects a well-formed ISO string that names a day nobody has, like `2026-02-31`. */
function isoIfReal(iso: string): string | null {
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}
