import { BadRequestException, ConflictException } from "@nestjs/common";
import { RecallSimulationService, type RecallImpact } from "../recall-simulation.service";
import type { CreateRecallInput } from "../dto/quality.schemas";

/**
 * What a recall covers, resolved through the simulator.
 *
 * The same code that answers "what would this recall touch" before anybody
 * commits to it — deliberately not a second implementation, because a recall
 * that quarantines a different set from the one the operator was shown is the
 * failure this whole flow exists to avoid.
 */
export interface RecallLinesDeps {
  readonly simulation: RecallSimulationService;
}

export /**
 * The lines a create request means, and the evidence it was justified by.
 *
 * An explicit `lines` list is taken at face value and carries no evidence. A
 * `selection` is re-simulated here — not trusted from the client — and the
 * hash compared: a selection that has since gained or lost a lot, moved
 * stock, or shipped another carton produces a different version, and the
 * execute is refused rather than acting on the operator's stale reading.
 */
async function resolveLines(
  deps: RecallLinesDeps,
  orgId: string,
  userId: string,
  input: CreateRecallInput,
): Promise<{
  lines: Array<{ productVariantId?: number; lotId?: number; serialId?: number }>;
  impact: RecallImpact | null;
}> {
  if (input.selection === undefined) {
    // The schema's refinement guarantees one of the two is present.
    return { lines: input.lines ?? [], impact: null };
  }

  const impact = await deps.simulation.simulate(orgId, userId, input.selection);

  if (impact.evidenceVersion !== input.evidenceVersion) {
    throw new ConflictException({
      code: "RECALL_EVIDENCE_STALE",
      message:
        "The stock picture changed since this recall was simulated. Re-run the simulation and review the impact before executing.",
      expectedEvidenceVersion: impact.evidenceVersion,
      submittedEvidenceVersion: input.evidenceVersion,
    });
  }

  if (impact.lots.length === 0) {
    throw new BadRequestException("This selection matches no lots, so there is nothing to recall");
  }

  return {
    lines: impact.lots.map((lot) => ({
      productVariantId: lot.productVariantId,
      lotId: lot.lotId,
    })),
    impact,
  };
}
