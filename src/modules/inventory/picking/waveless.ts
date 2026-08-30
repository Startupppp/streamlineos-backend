import { BadRequestException } from "@nestjs/common";

/**
 * NEO-14 - may this order join a wave that is already open?
 *
 * The decision, as a pure function, so the rule is one paragraph somebody can
 * read rather than a condition spread across a service.
 *
 * ## Why it is off by default
 *
 * A wave a picker is halfway through is a physical walk they have planned. Adding
 * a line to it behind them is a change to work in progress: at best a longer
 * walk, at worst a bin they have already passed. Manhattan sells order streaming
 * because at their scale a second trip is more expensive than a longer one; at
 * twenty people it is usually the other way round. So an organisation turns this
 * on having decided that, rather than inheriting it.
 *
 * ## The four conditions
 *
 * All of them, and each is a real refusal:
 *
 *   1. **The setting is on.** Otherwise a new order gets a new wave, which is
 *      what happened before this existed.
 *   2. **Same warehouse.** A wave is a walk through one building.
 *   3. **The wave has not been started.** Once a picker has confirmed a line
 *      they are walking a plan; a wave they have not touched is still a plan.
 *   4. **Under the cap.** A wave that grows without bound is a picker who never
 *      finishes - the failure mode of every "just add it to the current one"
 *      scheme.
 */
export interface OpenWave {
  id: number;
  warehouseId: number | null;
  status: string;
  lineCount: number;
  /** Lines the picker has already confirmed something against. */
  linesPicked: number;
}

export interface JoinDecision {
  join: boolean;
  waveId: number | null;
  /** Why not, for a caller that has to explain itself. Null when it joined. */
  reason: string | null;
}

/** Statuses in which a wave is still only a plan. */
const UNSTARTED = new Set(["PENDING", "ASSIGNED"]);

export function decideWaveJoin(params: {
  wavelessPicking: boolean;
  maxLines: number;
  warehouseId: number;
  newLineCount: number;
  openWaves: readonly OpenWave[];
}): JoinDecision {
  if (!params.wavelessPicking) {
    return { join: false, waveId: null, reason: "Waveless picking is switched off" };
  }
  if (params.newLineCount <= 0) {
    return { join: false, waveId: null, reason: "There are no lines to add" };
  }

  const candidates = params.openWaves
    .filter((wave) => wave.warehouseId === params.warehouseId)
    .filter((wave) => UNSTARTED.has(wave.status))
    .filter((wave) => wave.linesPicked === 0)
    .filter((wave) => wave.lineCount + params.newLineCount <= params.maxLines)
    // Fullest first, so waves are finished rather than all grown at once. A
    // building with six half-full waves is six walks; one full wave and five
    // empty ones is one.
    .sort((a, b) => b.lineCount - a.lineCount || a.id - b.id);

  const chosen = candidates[0];
  if (!chosen) {
    return {
      join: false,
      waveId: null,
      reason: "No open wave in this warehouse has room for these lines",
    };
  }
  return { join: true, waveId: chosen.id, reason: null };
}

/**
 * A line may be added to a wave exactly once.
 *
 * The reservation already stands against the order line; joining a wave does not
 * make a second one, and adding the same line twice would put the same promise
 * on the floor twice. Refused rather than deduplicated, because a caller asking
 * to add a line that is already there has lost track of something.
 */
export function assertNotAlreadyOnAWave(
  soLineId: number,
  existingPickLineSoIds: ReadonlySet<number>,
): void {
  if (existingPickLineSoIds.has(soLineId)) {
    throw new BadRequestException(
      `Sales-order line ${soLineId} is already on a pick wave`,
    );
  }
}
