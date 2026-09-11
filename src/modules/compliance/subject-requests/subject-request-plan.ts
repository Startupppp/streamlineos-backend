/**
 * What a subject request may do to each table, and what it may only report.
 *
 * Phase 3, tickets 17 and 18. `personal-data-registry.ts` says WHERE personal
 * data is and refuses, on purpose, to say what may be done to it: "inventing
 * [that many] of those would produce a document that looks like a compliance
 * control and is not one." This file is the other half, and it is deliberately
 * tiny. It declares a disposition for the handful of tables where the answer is
 * not a judgement call, and says nothing at all about the rest.
 *
 * That asymmetry is the whole design, and it splits the two kinds cleanly:
 *
 * EXPORT needs no disposition. "Give the subject what you hold" has one answer
 * for every table, so the inventory IS the enumeration and an export can be
 * genuinely complete over it.
 *
 * ERASURE cannot be driven off an inventory. A table with no declared
 * disposition is neither erased (that invents the legal decision the registry
 * refuses to invent) nor skipped in silence (that is a partial erasure reported
 * as complete). It is COUNTED and NAMED in the outcome, so the row a regulator
 * reads says "142 tables hold your data and nobody has decided what happens to
 * them" instead of saying nothing. `mayFileAsComplete` then refuses to call the
 * request complete while any of those actually held a row.
 *
 * The gap is meant to be visible and uncomfortable. Closing it is legal work,
 * one table at a time, and each closure is a line added below with the argument
 * attached.
 */

import { PERSONAL_DATA_TABLES, type PersonalDataTable } from "../personal-data-registry";
import {
  mayReportComplete,
  type SubjectRequestKind,
  type SubjectRequestResult,
} from "./subject-request";

export type Disposition = "erase" | "retain";

/** What the executor is allowed to do to a table. `undeclared` means: nothing. */
export type PlannedDisposition = Disposition | "undeclared";

export interface DeclaredDisposition {
  readonly table: string;
  readonly disposition: Disposition;
  /** Why this one has a legal answer that does not depend on the case. */
  readonly why: string;
}

/**
 * The tables whose disposition is not a judgement call.
 *
 * Short by construction. Every entry had to survive the question "would two
 * competent advisers give the same answer without knowing anything about this
 * particular subject?" — and most tables do not.
 *
 * NOT DECLARED, AND WHY, for the near misses that keep getting proposed:
 *
 *   `platform_messages` — an inbound contact-form message. Consent-only if it
 *   is a sales enquiry and evidence if it is a complaint, and the row does not
 *   say which.
 *
 *   `crm_outbound_messages`, `email_sequence_enrollments` — marketing sent to
 *   the subject. Erasing them destroys the proof that consent existed when it
 *   was sent, which is the record you need if the sending is ever challenged.
 *
 *   `nps_responses`, `csat_responses` — the honest answer here is anonymise,
 *   not erase or retain, and this file has no third disposition because
 *   anonymisation is per-column work that nobody has specified.
 *
 *   `gl_parties`, `billing_profiles` — statutory retention plainly covers the
 *   invoice documents; whether it reaches the counterparty master record is
 *   exactly the argument a lawyer is for.
 */
export const DECLARED_DISPOSITIONS: readonly DeclaredDisposition[] = [
  {
    table: "platform_waitlist",
    disposition: "erase",
    why:
      "A pre-contractual marketing list, held on consent and nothing else: no " +
      "contract, no statutory retention, no third party with a right in the " +
      "row. Withdrawn consent leaves nothing behind it. The counter-argument " +
      "is `claimed_org_id` — a claimed row records how an organisation began — " +
      "but that is funnel attribution, not a record either side needs, and the " +
      "organisation exists independently of the waitlist row that preceded it.",
  },
  {
    table: "subprocessor_subscribers",
    disposition: "erase",
    why:
      "An opt-IN to be told when the subprocessor register changes. The " +
      "distinction from `email_suppressions` below is the one that matters and " +
      "it is not subtle: for an opt-in, absence means not subscribed, so " +
      "deleting the row lands the subject exactly where they asked to be. For a " +
      "suppression, absence means we may mail them again.",
  },
  {
    table: "subject_requests",
    disposition: "retain",
    why:
      "The record of this request. A right that cannot be evidenced was not " +
      "exercised, and the erasure record is the evidence — it is on " +
      "GLOBAL_PERSONAL_DATA_TABLES precisely because it keeps the subject's " +
      "email forever, on purpose. Erasing it would also delete the row being " +
      "written by the run that erased it.",
  },
  {
    table: "email_suppressions",
    disposition: "retain",
    why:
      "The schema already argues this one: `email_suppressions` is keyed on the " +
      "address rather than a user FK because 'purging a user would resurrect " +
      "their bounced address' and 'a hard bounce must outlive the account'. " +
      "Deleting a " +
      "suppression resumes contact with someone who asked for it to stop, " +
      "which is the opposite of the request being honoured.",
  },
  {
    table: "crm_suppression_hashes",
    disposition: "retain",
    why:
      "Same argument as `email_suppressions`, and already minimised — the " +
      "column is a digest, not an address. Moot today, because the locator " +
      "below matches plaintext and can never match a hash. Declared anyway: " +
      "the day somebody teaches the locator to hash the subject's address is " +
      "the day this table would otherwise be silently emptied.",
  },
  {
    table: "sign_recipients",
    disposition: "retain",
    why:
      "The identity of the person who signed is what makes the signature " +
      "attributable, and an executed document whose signer has been erased is " +
      "no longer evidence of anything. The counterparty's interest in the " +
      "contract is a third-party right the subject cannot waive alone.",
  },
  {
    table: "sign_audit_events",
    disposition: "retain",
    why:
      "The trail behind the signature — viewed, consented, signed, from where. " +
      "It is retained for the same reason as the recipient row and is useless " +
      "in halves, so erasing the trail while keeping the signature would leave " +
      "an attributable document with nothing supporting it.",
  },
  {
    table: "invoices",
    disposition: "retain",
    why:
      "Tax law sets the retention period for issued invoices and the subject " +
      "cannot shorten it. This is the clearest table in the whole registry: " +
      "erasing it would not merely be a judgement call made wrongly, it would " +
      "be unlawful.",
  },
];

const DISPOSITION_BY_TABLE: ReadonlyMap<string, Disposition> = new Map(
  DECLARED_DISPOSITIONS.map((entry) => [entry.table, entry.disposition]),
);

export function dispositionOf(table: string): PlannedDisposition {
  return DISPOSITION_BY_TABLE.get(table) ?? "undeclared";
}

/**
 * A column name that unambiguously holds an email ADDRESS.
 *
 * Anchored at the end for a reason. The registry lists `email_enabled`,
 * `email_verified`, `email_sent_at` and `email_status` on dozens of tables —
 * booleans, timestamps and enums that the generating scan matched on the
 * substring. Comparing an address against `email_enabled` is a type error at
 * best and a silently false predicate at worst, so `contact_email` and
 * `to_email` are in and `email_enabled` is out.
 */
const IDENTIFIES_BY_EMAIL = /(^|_)email$/;

/**
 * Names that hold an address without ending in `email`, listed by hand.
 *
 * `recipient_address` may hold a phone number when the channel is WhatsApp;
 * that is harmless here, because the predicate is equality against an address
 * and a phone number simply never matches one.
 */
const ALSO_AN_ADDRESS: ReadonlySet<string> = new Set(["mailbox_address", "recipient_address"]);

export function emailColumnsOf(entry: PersonalDataTable): readonly string[] {
  return entry.columns.filter(
    (column) => IDENTIFIES_BY_EMAIL.test(column) || ALSO_AN_ADDRESS.has(column),
  );
}

export interface TablePlan {
  readonly table: string;
  /** Columns an address can be matched against. Empty means: not findable here. */
  readonly emailColumns: readonly string[];
  readonly disposition: PlannedDisposition;
}

/**
 * The whole enumeration, in registry order.
 *
 * Every registry table appears, including the ones with no matchable column —
 * dropping those would turn "we cannot find you in `login_history`" into
 * silence, and silence is what this whole surface exists to stop.
 *
 * Note what is NOT here: a table is not reached by following a foreign key to
 * `users`. `scripts/purge-user.mjs` does that, and it is why that script deletes
 * rows the subject merely CREATED — a deal whose `created_by` is the subject is
 * the organisation's record, not the subject's personal data. Deciding which
 * user-linked rows belong to the person is the same per-table judgement the
 * registry refuses to invent, so the locator matches an address or reports that
 * it cannot.
 */
export const SUBJECT_REQUEST_PLAN: readonly TablePlan[] = PERSONAL_DATA_TABLES.map((entry) => ({
  table: entry.table,
  emailColumns: emailColumnsOf(entry),
  disposition: dispositionOf(entry.table),
}));

/**
 * Why a table produced the numbers it did.
 *
 * `absent` and `not-identifiable` are recorded rather than filtered out: the
 * count of tables a request could not look inside is a fact about the request.
 */
export type TableStatus = "scanned" | "absent" | "not-identifiable";

export interface TableOutcome {
  readonly table: string;
  readonly disposition: PlannedDisposition;
  readonly status: TableStatus;
  /** Rows found holding the subject's address. */
  readonly rowsMatched: number;
  /** Rows actually deleted. Non-zero only where the disposition is `erase`. */
  readonly rowsErased: number;
  /** Export only: more rows matched than the export cap would carry. */
  readonly truncated?: boolean;
}

/**
 * Tables that hold the subject and that nobody has decided about.
 *
 * A table with no declared disposition and no matching row is not a gap — there
 * is nothing there to decide about. The gap is a table that holds the subject's
 * data and has no answer, and that is the list this returns.
 */
export function undeclaredTablesHoldingData(
  outcomes: readonly TableOutcome[],
): readonly string[] {
  const named = new Set<string>();
  for (const outcome of outcomes)
    if (outcome.disposition === "undeclared" && outcome.rowsMatched > 0) named.add(outcome.table);

  return [...named].sort();
}

/**
 * Whether the request may be filed as complete.
 *
 * `mayReportComplete` decides the region layer — every configured region was
 * visited and succeeded. This adds the table layer, which is the one an
 * inventory-driven erasure gets wrong: a run can visit every region, succeed
 * everywhere, and still have left the subject's rows in a hundred and forty
 * tables because nobody ever decided what to do with them.
 *
 * Export is held to the region rule alone. Nothing is decided per table when
 * the terminal action is "hand it over", so an export that visited everywhere
 * and carried every row it found is complete — and a truncated one is not,
 * because a capped table is data we hold and did not give.
 */
export function mayFileAsComplete(
  kind: SubjectRequestKind,
  result: SubjectRequestResult,
  configuredRegions: readonly string[],
  tableOutcomes: readonly TableOutcome[],
): boolean {
  if (!mayReportComplete(result, configuredRegions)) return false;
  if (tableOutcomes.some((outcome) => outcome.truncated)) return false;
  if (kind === "export") return true;

  return undeclaredTablesHoldingData(tableOutcomes).length === 0;
}
