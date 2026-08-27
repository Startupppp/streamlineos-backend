import type { SignalReversibility } from "../relationships/relationship-signals";
import type {
  CustomerLifecycleSignalKind,
  CustomerLifecycleStage,
  TermSource,
} from "../../db/schema/crm/customer-lifecycle";

/**
 * The record a won deal turns into, and the rules that decide its shape.
 *
 * Phase 6, ticket 07. Pure, because "when does this contract come up for
 * renewal" is the question the whole phase turns on and it should be arguable
 * without a database — the service's job is to find a won deal and a party, and
 * this file's job is to say what that means.
 *
 * The signal vocabulary is imported rather than restated. `SignalReversibility`
 * comes from `relationship-signals.ts`, which took it from `decision-record.ts`,
 * so there is one answer to "how far may this be acted on without a human" and
 * not three that can disagree.
 */

/**
 * What changed about a customer, in the shape the relationships loop already uses.
 *
 * Same four fields as `RelationshipSignal` with this phase's kinds. A second
 * notion of a signal — its own field names, its own idea of evidence — is how
 * two review surfaces end up unable to show the same list.
 */
export interface CustomerLifecycleSignal {
  readonly kind: CustomerLifecycleSignalKind;
  readonly evidence: Readonly<Record<string, string | number | null>>;
  readonly reversibility: SignalReversibility;
  /** One line, for the review feed. */
  readonly summary: string;
  readonly observedAt: Date;
}

/**
 * How long a contract runs when nobody said.
 *
 * A won deal carries a value and a close date and no term, because a term is
 * something the contract says and the pipeline never asked. Twelve months is the
 * commonest annual subscription and it is the wrong answer for every monthly
 * one, which is exactly why `termSource` is a column: a reader can tell a term
 * the tenant stated from one the platform assumed, and a renewal date built on
 * an assumption is visibly built on an assumption.
 */
export const DEFAULT_TERM_MONTHS = 12;

/** Terms outside this are a typo or a units mistake, not a contract. */
const MIN_TERM_MONTHS = 1;
const MAX_TERM_MONTHS = 120;

export class LifecycleRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleRecordError";
  }
}

export interface ClosedWonDeal {
  readonly dealId: string;
  readonly organizationId: string;
  readonly partyId: string;
  readonly valueMinor: number;
  readonly currencyCode: string;
  /** When it closed. The term runs from here, not from when the sweep noticed. */
  readonly closedAt: Date;
  /**
   * A term the tenant recorded on the deal, where they record one at all.
   *
   * Read from the deal's own custom data by the caller rather than from a column
   * this phase would have had to add to `deals` — a tenant who models terms
   * already has somewhere to put one, and a tenant who does not gets the
   * default and a `termSource` saying so.
   */
  readonly termMonths: number | null;
}

export interface LifecycleRecord {
  readonly organizationId: string;
  readonly partyId: string;
  readonly originDealId: string;
  readonly stage: CustomerLifecycleStage;
  readonly termMonths: number;
  readonly termSource: TermSource;
  readonly contractValueMinor: number;
  readonly currencyCode: string;
  readonly startedAt: Date;
  /** `YYYY-MM-DD`, matching the `date` column it is written to. */
  readonly renewalDate: string;
}

/**
 * When a term that began on one day comes up again.
 *
 * Calendar months rather than a fixed number of days, because a twelve-month
 * term sold on the 3rd of March renews on the 3rd of March and not on the 2nd.
 * A term beginning on the 31st lands on a month with no 31st, and the day is
 * clamped back to the last of that month — the alternative, letting the date
 * roll into the next month, means a January contract renewing in March.
 *
 * Everything is computed in UTC. The legacy service parsed renewal dates at
 * local midnight, so the same contract was a day nearer renewal depending on
 * which region the process happened to run in.
 */
export function renewalDateFor(startedAt: Date, termMonths: number): string {
  const year = startedAt.getUTCFullYear();
  const month = startedAt.getUTCMonth();
  const day = startedAt.getUTCDate();

  const target = new Date(Date.UTC(year, month + termMonths, 1));
  const lastOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  const renewal = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastOfTargetMonth)),
  );
  return toDateText(renewal);
}

/** The `YYYY-MM-DD` a `date` column stores, always in UTC. */
export function toDateText(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * How far off a renewal is, read the same way everywhere.
 *
 * A `date` column has no time and no zone, so it is read as UTC midnight and
 * compared against a UTC-truncated now. Whole days, and negative once the date
 * has passed — a renewal that went by unworked is a fact worth being able to
 * say out loud rather than clamping to zero.
 */
export function daysUntil(renewalDate: string, now: Date): number {
  const renewal = Date.parse(`${renewalDate}T00:00:00Z`);
  if (Number.isNaN(renewal))
    throw new LifecycleRecordError(`renewal date "${renewalDate}" is not a date`);

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((renewal - today) / 86_400_000);
}

/**
 * The lifecycle a won deal produces.
 *
 * Throws rather than inventing anything when the deal has no party: the record's
 * entire value is that one customer has one view of themselves, and a lifecycle
 * anchored to nothing would be a second orphaned account of exactly the kind
 * this phase exists to stop making.
 */
export function lifecycleFromClosedWonDeal(deal: ClosedWonDeal): LifecycleRecord {
  if (!deal.partyId)
    throw new LifecycleRecordError(`deal ${deal.dealId} closed won with no party to anchor to`);

  const stated = deal.termMonths;
  const usable =
    typeof stated === "number" &&
    Number.isInteger(stated) &&
    stated >= MIN_TERM_MONTHS &&
    stated <= MAX_TERM_MONTHS;

  const termMonths = usable ? stated : DEFAULT_TERM_MONTHS;
  const termSource: TermSource = usable ? "deal" : "default";

  return {
    organizationId: deal.organizationId,
    partyId: deal.partyId,
    originDealId: deal.dealId,
    stage: "active",
    termMonths,
    termSource,
    // The value of the contract is what the deal was worth. Minor units the
    // whole way — `deals.value_minor` is already integer and the decimal beside
    // it is a generated column nobody may write.
    contractValueMinor: deal.valueMinor,
    currencyCode: deal.currencyCode,
    startedAt: deal.closedAt,
    renewalDate: renewalDateFor(deal.closedAt, termMonths),
  };
}

/** The signal that says a customer now has an after. */
export function lifecycleOpenedSignal(record: LifecycleRecord): CustomerLifecycleSignal {
  return {
    kind: "lifecycle.opened",
    evidence: {
      originDealId: record.originDealId,
      termMonths: record.termMonths,
      termSource: record.termSource,
      contractValueMinor: record.contractValueMinor,
      currencyCode: record.currencyCode,
      renewalDate: record.renewalDate,
    },
    // Writing down that a customer exists changes nothing on its own.
    reversibility: "instant",
    summary:
      record.termSource === "default"
        ? `Contract opened from deal ${record.originDealId}; term assumed at ${record.termMonths} months, renewing ${record.renewalDate}`
        : `Contract opened from deal ${record.originDealId}, ${record.termMonths} months, renewing ${record.renewalDate}`,
    observedAt: record.startedAt,
  };
}
