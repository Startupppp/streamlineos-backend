/**
 * Noticing a competitor, and refusing to act on having noticed.
 *
 * CRM-P2-12. Manual capture stays the record: `crm_deal_competitors` is written
 * by people and read by everything. What this file adds is the step before it —
 * the system may say "this name appeared on the call you logged", and it may say
 * nothing else. It does not open a deal, it does not tick a box, it does not
 * write a field.
 *
 * Pure and database-free on purpose, and for the same reason
 * `outbound-eligibility.ts` is: the part of this feature worth arguing with is
 * "what counts as noticing", and that argument should be readable without a
 * schema and testable without a model.
 *
 * ## The vocabulary is closed
 *
 * `proposeCompetitors` cannot name anything. It is handed the organisation's own
 * competitor vocabulary — the `crm_options` a person curated plus the
 * `competitor_key`s people already captured on other deals — and it can only
 * report that one of those strings occurred. That is not a detail of the
 * implementation; it is the safety property. A free extraction would eventually
 * propose a customer's own product, a colleague's surname or a misread acronym,
 * and each of those, accepted once by a tired reviewer, becomes a permanent
 * claim on a customer record. Bounded to what a person already typed, the worst
 * failure available is proposing a real competitor on the wrong deal, which a
 * reader can see is wrong from the quote sitting next to it.
 *
 * This is also why the quote is mandatory rather than nice to have. A proposal
 * with no evidence is an assertion, and an assertion is the thing a person
 * cannot check.
 *
 * ## No autonomous acceptance
 *
 * `HumanConfirmation` is the token the write path demands, and the symbol that
 * brands it is not exported. No other module can construct the type, and inside
 * this one the only producer is `confirmedByPerson`, which needs a request actor
 * and the exact name that actor was shown. A future caller wanting to apply a
 * suggestion without a person would have to invent a user id and forge a
 * confirmation, at which point they are not making a mistake. Postgres holds the
 * same line independently — see the check constraint in migration 0669 — so
 * neither layer is the only thing standing there.
 */

/** How much of the line around a mention is kept as evidence. */
export const EVIDENCE_QUOTE_MAX_CHARS = 300;

/**
 * How many proposals one scan may raise.
 *
 * A cap and not a page size. Twenty unreviewed suggestions on one deal is
 * already a queue nobody works through, and a scan that returned sixty would
 * turn a helpful prompt into a chore that gets dismissed wholesale — which
 * teaches people to dismiss without reading, the one habit that would make this
 * feature dangerous.
 */
export const MAX_PROPOSALS_PER_SCAN = 20;

/**
 * How much timeline one scan reads.
 *
 * The recent past is where a live competitive threat is discussed; a mention
 * from two years and three renewals ago is history, and surfacing it as news
 * costs a reviewer more than it tells them.
 */
export const MAX_ACTIVITIES_PER_SCAN = 50;

/** A name the organisation already maintains, and how it is written. */
export interface CompetitorVocabularyTerm {
  readonly competitorKey: string;
  readonly label: string;
}

/** One timeline entry, reduced to the text a name could appear in. */
export interface ScannedActivity {
  readonly activityId: string;
  readonly subject: string | null;
  readonly body: string | null;
}

/** A name that appeared, where it appeared, and the line it appeared in. */
export interface CompetitorProposal {
  readonly competitorKey: string;
  readonly sourceActivityId: string;
  readonly evidenceQuote: string;
}

/**
 * The one symbol that makes a confirmation unforgeable, and it does not leave
 * this module. An interface keyed on a private `unique symbol` has no object
 * literal outside the file that can satisfy it, so `HumanConfirmation` is
 * genuinely unconstructable elsewhere rather than merely discouraged.
 */
const HUMAN_CONFIRMATION = Symbol("deals.competitor-suggestion.human");

/**
 * Proof that a named person read a specific proposal and agreed to it.
 *
 * Carries the actor because the row must record who decided, and the key
 * because agreeing to "a suggestion" is not the same act as agreeing to
 * "Zoho on this deal" — the id alone would let a stale screen accept a
 * proposal whose text has since changed underneath it.
 */
export interface HumanConfirmation {
  readonly proof: typeof HUMAN_CONFIRMATION;
  readonly actorUserId: string;
  readonly confirmedCompetitorKey: string;
}

/**
 * Mints a confirmation, or refuses.
 *
 * Null when the person echoed back a different name from the one stored, which
 * is not a validation nicety: it is the check that the decision was taken
 * against what was actually proposed. The alternative — accepting by id alone —
 * is a click, and a click is exactly what this ticket exists to refuse to treat
 * as consent.
 */
export function confirmedByPerson(
  actor: { readonly userId: string },
  proposedCompetitorKey: string,
  echoedCompetitorKey: string,
): HumanConfirmation | null {
  if (proposedCompetitorKey !== echoedCompetitorKey) return null;
  return {
    proof: HUMAN_CONFIRMATION,
    actorUserId: actor.userId,
    confirmedCompetitorKey: echoedCompetitorKey,
  };
}

/** Everything a regex would otherwise read as syntax. */
function escapeForPattern(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where a term occurs as a word, or -1.
 *
 * Bounded on letters and digits rather than on `\b`, because a competitor name
 * routinely ends in punctuation `\b` treats as part of the word — `Zoho.com`,
 * `C4` — and because the boundary has to hold for non-Latin scripts, which
 * `\b` does not. Substring matching without a boundary was the other option and
 * is worse: "Ace" would fire on "acceptable" and put a rival on a deal because
 * a rep wrote a polite sentence.
 */
function wordIndexOf(haystack: string, term: string): number {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeForPattern(term)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return haystack.search(pattern);
}

/**
 * The sentence a match sits in, trimmed to something readable.
 *
 * Sentence rather than a fixed window either side, because a window cuts words
 * in half and a half-quoted customer is worse than no quote. When the sentence
 * itself is long the tail is dropped and marked, so the reader can tell they are
 * seeing part of one.
 */
export function evidenceQuoteFor(text: string, matchIndex: number): string {
  const before = text.slice(0, matchIndex);
  const boundary = Math.max(
    before.lastIndexOf(". "),
    before.lastIndexOf("! "),
    before.lastIndexOf("? "),
    before.lastIndexOf("\n"),
  );
  const start = boundary === -1 ? 0 : boundary + 1;

  const rest = text.slice(matchIndex);
  const endOffset = rest.search(/[.!?\n]/);
  const end = endOffset === -1 ? text.length : matchIndex + endOffset + 1;

  const sentence = text.slice(start, end).trim();
  if (sentence.length <= EVIDENCE_QUOTE_MAX_CHARS) return sentence;
  return `${sentence.slice(0, EVIDENCE_QUOTE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Subject and body read as one body of text; a name can be in either. */
function textOf(activity: ScannedActivity): string {
  return [activity.subject, activity.body]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

/**
 * Every vocabulary term that occurs in the given activities, once each.
 *
 * Once each, and against the most recent activity that mentions it, because the
 * activities arrive newest-first and the reviewer's question is "is this live",
 * not "when did it start". A term already on the deal is skipped rather than
 * proposed-and-ignored: proposing something the deal already records would make
 * the queue mostly noise on exactly the deals people have been diligent about.
 */
export function proposeCompetitors(
  vocabulary: readonly CompetitorVocabularyTerm[],
  activities: readonly ScannedActivity[],
  alreadyKnown: ReadonlySet<string>,
): CompetitorProposal[] {
  const proposals: CompetitorProposal[] = [];
  const taken = new Set<string>();

  for (const activity of activities) {
    if (proposals.length >= MAX_PROPOSALS_PER_SCAN) break;
    const text = textOf(activity);
    if (!text) continue;

    for (const term of vocabulary) {
      if (proposals.length >= MAX_PROPOSALS_PER_SCAN) break;
      if (taken.has(term.competitorKey)) continue;
      if (alreadyKnown.has(term.competitorKey)) continue;

      /**
       * The label is what a person reads and the key is what is stored, and they
       * are not always the same string — `zoho` labelled "Zoho CRM". Both are
       * searched so a rep writing either one is understood, and the key is what
       * the proposal carries so accepting it produces the row the rest of the
       * product already keys on.
       */
      const matchIndex = [term.label, term.competitorKey]
        .filter((candidate) => candidate.trim().length > 1)
        .map((candidate) => wordIndexOf(text, candidate.trim()))
        .filter((index) => index !== -1)
        .sort((a, b) => a - b)[0];
      if (matchIndex === undefined) continue;

      taken.add(term.competitorKey);
      proposals.push({
        competitorKey: term.competitorKey,
        sourceActivityId: activity.activityId,
        evidenceQuote: evidenceQuoteFor(text, matchIndex),
      });
    }
  }

  return proposals;
}
