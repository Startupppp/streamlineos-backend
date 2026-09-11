/**
 * A data subject's request, carried out across every region.
 *
 * Phase 3 tickets 17 and 18. Erasure and export are **one mechanism with two
 * terminal actions**, and that is the load-bearing decision here: an export
 * built separately from the erasure quietly goes incomplete, because the two
 * enumerations drift and only one of them is ever exercised in anger.
 *
 * Everything below is pure. The enumeration, the completeness rule and the
 * outcome shape are decided here and tested without a database, because the
 * property that matters -- that every configured region was visited and said so
 * -- is exactly the property a mocked single-region test would report as held.
 */

export type SubjectRequestKind = "erasure" | "export";

export type RegionStatus = "completed" | "failed";

export interface RegionOutcome {
  readonly region: string;
  readonly status: RegionStatus;
  /** How many rows were erased, or exported. Zero is a real answer. */
  readonly recordsAffected: number;
  /** ISO 8601, so the record says when each region was actually done. */
  readonly at: string;
  readonly error?: string;
}

export interface SubjectRequestResult {
  readonly kind: SubjectRequestKind;
  readonly subjectEmail: string;
  readonly regions: readonly RegionOutcome[];
  /**
   * True only when every configured region reported success.
   *
   * A partial result is the dangerous state: it looks like completion to anyone
   * reading a summary, and the row a regulator asks about is in the region that
   * failed.
   */
  readonly complete: boolean;
  readonly totalRecordsAffected: number;
  /**
   * When the last copy expires, stated rather than implied.
   *
   * Backups are covered by policy and schedule rather than by deletion -- you
   * cannot reach into a backup generation to remove one subject without
   * invalidating the backup. Saying so lets the customer be told a date instead
   * of being given a promise nobody can keep.
   */
  readonly backupsExpireBy: string | null;
}

export interface RegionWork {
  readonly region: string;
  readonly run: () => Promise<number>;
}

/**
 * Runs the work in every region and reports per region.
 *
 * A region that fails does not stop the others: knowing which three of four
 * succeeded is the point, and stopping at the first failure leaves the remaining
 * regions in an unknown state rather than a failed one.
 */
export async function runAcrossRegions(
  kind: SubjectRequestKind,
  subjectEmail: string,
  work: readonly RegionWork[],
  now: () => Date,
  backupsExpireBy: string | null = null,
): Promise<SubjectRequestResult> {
  if (work.length === 0)
    throw new Error(
      "[compliance] a subject request must enumerate at least one region. " +
        "An empty enumeration reports success without having looked anywhere.",
    );

  const regions: RegionOutcome[] = [];

  for (const item of work) {
    try {
      const recordsAffected = await item.run();
      regions.push({
        region: item.region,
        status: "completed",
        recordsAffected,
        at: now().toISOString(),
      });
    } catch (error) {
      regions.push({
        region: item.region,
        status: "failed",
        recordsAffected: 0,
        at: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    kind,
    subjectEmail,
    regions,
    complete: regions.every((outcome) => outcome.status === "completed"),
    totalRecordsAffected: regions.reduce((total, o) => total + o.recordsAffected, 0),
    backupsExpireBy,
  };
}

/**
 * Whether a result may be reported to the subject as done.
 *
 * Separate from `complete` on purpose: `complete` is a fact about the run, this
 * is a decision about what may be said. A request that visited fewer regions
 * than are configured is not complete however many succeeded -- that is the
 * failure mode where a region was added and the enumeration was not updated.
 */
export function mayReportComplete(
  result: SubjectRequestResult,
  configuredRegions: readonly string[],
): boolean {
  if (!result.complete) return false;

  const visited = new Set(result.regions.map((outcome) => outcome.region));
  return configuredRegions.length > 0 && configuredRegions.every((region) => visited.has(region));
}

/** What went wrong, for a record a regulator may read. */
export function failureSummary(result: SubjectRequestResult): string | null {
  const failed = result.regions.filter((outcome) => outcome.status === "failed");
  if (failed.length === 0) return null;

  return failed
    .map((outcome) => `${outcome.region}: ${outcome.error ?? "unknown error"}`)
    .join("; ");
}
