import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { DemandBaselineService, type DemandScope } from "./demand-baseline.service";
import { SafetyStockPolicyService } from "./safety-stock-policy.service";
import { safetyStock } from "./safety-stock";

export interface SimulationScenario {
  /** Multiplier on measured demand. 1.2 asks "what if we sell 20% more". */
  demandMultiplier?: number;
  /** Absolute override, in weeks. Asks "what if this supplier took three weeks". */
  leadTimeWeeks?: number;
  /** Absolute override for lead-time deviation, in weeks. */
  leadTimeStdDevWeeks?: number;
  serviceLevel?: number;
}

export interface SimulationOutcome {
  label: string;
  serviceLevel: number;
  demandMean: number;
  leadTimeWeeks: number;
  safetyStock: number;
  reorderPoint: number;
  /** Against the measured baseline. Positive means this scenario holds more. */
  deltaSafetyStock: number;
  deltaReorderPoint: number;
}

export interface SimulationResult {
  productVariantId: number;
  /** Null when the simulation covers the whole organisation. */
  warehouseId: number | null;
  applicable: boolean;
  /** Why not, when the model does not describe this demand. */
  reason?: string;
  baseline: SimulationOutcome | null;
  scenarios: SimulationOutcome[];
  caveats: string[];
}

/**
 * INV-306 — what-if replenishment.
 *
 * Two rules from the phase, and both are structural rather than advisory.
 *
 * **A simulation never mutates inventory.** Nothing in this file writes. It
 * reads the measured position, recomputes the policy arithmetic under altered
 * assumptions, and returns numbers. There is no code path from here to the
 * stock engine, which is the only way to make that guarantee cheap to verify.
 *
 * **A scenario is compared, not just reported.** A safety stock of 480 means
 * nothing on its own; "310 more than today" is the sentence a planner acts on.
 * So every outcome carries its delta against the measured baseline, and the
 * baseline is computed the same way rather than being a remembered number.
 *
 * The simulator inherits the refusal from INV-303: where the demand shape
 * cannot support a normal-model safety stock, it declines rather than
 * simulating something it could not have computed in the first place. A what-if
 * built on a number that was never valid is a more confident version of the
 * same mistake.
 */
@Injectable()
export class ReplenishmentSimulatorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly baselines: DemandBaselineService,
    private readonly policies: SafetyStockPolicyService,
  ) {}

  async simulate(
    orgId: string,
    productVariantId: number,
    scenarios: Array<SimulationScenario & { label: string }>,
    options: { weeks?: number; serviceLevel?: number } & DemandScope = {},
  ): Promise<SimulationResult> {
    const warehouseId = options.warehouseId ?? null;
    if (scenarios.length === 0) {
      throw new BadRequestException("At least one scenario is required");
    }
    if (scenarios.length > 20) {
      // A simulator that will run any number of scenarios becomes a way to make
      // the database do arbitrary work from a query string.
      throw new BadRequestException("At most 20 scenarios per request");
    }

    const baseServiceLevel = options.serviceLevel ?? 0.95;
    const policy = await this.policies.policyFor(orgId, productVariantId, {
      serviceLevel: baseServiceLevel,
      weeks: options.weeks,
      warehouseId,
    });

    if (!policy.applicable || policy.policy === null) {
      return {
        productVariantId,
        warehouseId,
        applicable: false,
        reason:
          policy.notes[0] ??
          "The safety-stock model does not describe this demand, so there is nothing to vary.",
        baseline: null,
        scenarios: [],
        caveats: policy.notes,
      };
    }

    const measured = {
      demandMean: policy.demand.mean,
      demandStdDev: policy.demand.stdDev,
      leadTimePeriods: policy.leadTime.periods,
      leadTimeStdDev: policy.leadTime.stdDev,
    };

    const baseline: SimulationOutcome = {
      label: "measured",
      serviceLevel: baseServiceLevel,
      demandMean: measured.demandMean,
      leadTimeWeeks: measured.leadTimePeriods,
      safetyStock: policy.policy.safetyStock,
      reorderPoint: policy.policy.reorderPoint,
      deltaSafetyStock: 0,
      deltaReorderPoint: 0,
    };

    const outcomes = scenarios.map((scenario) => {
      const demandMean = measured.demandMean * (scenario.demandMultiplier ?? 1);
      // The deviation scales with the level rather than staying fixed: a
      // business selling 20% more does not sell it with the same absolute
      // week-to-week spread, and holding sigma constant quietly makes every
      // growth scenario look safer than it is.
      const demandStdDev = measured.demandStdDev * (scenario.demandMultiplier ?? 1);
      const leadTimePeriods = scenario.leadTimeWeeks ?? measured.leadTimePeriods;
      const leadTimeStdDev = scenario.leadTimeStdDevWeeks ?? measured.leadTimeStdDev;
      const serviceLevel = scenario.serviceLevel ?? baseServiceLevel;

      const result = safetyStock({
        demandMean,
        demandStdDev,
        leadTimePeriods,
        leadTimeStdDev,
        serviceLevel,
      });

      return {
        label: scenario.label,
        serviceLevel,
        demandMean: Number(demandMean.toFixed(4)),
        leadTimeWeeks: Number(leadTimePeriods.toFixed(4)),
        safetyStock: result.safetyStock,
        reorderPoint: result.reorderPoint,
        deltaSafetyStock: Number(
          (result.safetyStock - baseline.safetyStock).toFixed(4),
        ),
        deltaReorderPoint: Number(
          (result.reorderPoint - baseline.reorderPoint).toFixed(4),
        ),
      } satisfies SimulationOutcome;
    });

    return {
      productVariantId,
      warehouseId,
      applicable: true,
      baseline,
      scenarios: outcomes,
      caveats: policy.notes,
    };
  }
}
