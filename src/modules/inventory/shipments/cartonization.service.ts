import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invCartonTypes, invProductVariants } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";

export interface CartonizationLine {
  productVariantId: number;
  quantity: number;
}

export interface CartonCandidate {
  cartonTypeId: number;
  code: string;
  name: string;
  capacityWeightGrams: number;
  capacityVolumeMm3: number;
  fits: boolean;
  /** Why not, when it does not. */
  reasons: string[];
}

export interface CartonizationResult {
  totalWeightGrams: number;
  totalVolumeMm3: number;
  /**
   * Variants with no measurements. Any of these and the answer is a guess: the
   * totals below are lower bounds, not the real thing.
   */
  unmeasuredVariantIds: number[];
  /** Null when nothing fits, or when too much is unmeasured to say. */
  recommended: CartonCandidate | null;
  candidates: CartonCandidate[];
}

/**
 * INV-206 — carton selection.
 *
 * **This is a volumetric and longest-edge check, not three-dimensional bin
 * packing.** It answers "could this plausibly go in that box" and deliberately
 * does not claim to answer "will it". Real packing depends on shape, stacking,
 * fragility and the packer's judgement, and a system that asserted a fit it
 * cannot actually compute would be trusted exactly once.
 *
 * What it does check is the two things that make a wrong answer expensive:
 *
 *   **Weight**, because a carton over its rating fails in transit rather than
 *   at the bench, and by then it is somebody else's floor.
 *
 *   **The longest edge**, because volume alone is a liar. A two-metre pole has
 *   a small volume and fits in no small box, and a check that multiplied three
 *   numbers together would happily approve it.
 *
 * An unmeasured item makes the whole answer provisional, and that is reported
 * rather than papered over. Treating a missing dimension as zero would let
 * anything fit, which is the most dangerous possible default.
 */
@Injectable()
export class CartonizationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async suggest(
    orgId: string,
    lines: readonly CartonizationLine[],
  ): Promise<CartonizationResult> {
    if (lines.length === 0) {
      throw new BadRequestException("Nothing to pack");
    }

    const variantIds = [...new Set(lines.map((l) => l.productVariantId))];
    const variants = await this.db
      .select({
        id: invProductVariants.id,
        weightGrams: invProductVariants.weightGrams,
        lengthMm: invProductVariants.lengthMm,
        widthMm: invProductVariants.widthMm,
        heightMm: invProductVariants.heightMm,
      })
      .from(invProductVariants)
      .where(
        and(
          eq(invProductVariants.orgId, orgId),
          inArray(invProductVariants.id, variantIds),
        ),
      );

    const byId = new Map(variants.map((v) => [v.id, v]));
    const unmeasuredVariantIds: number[] = [];
    let totalWeightGrams = 0;
    let totalVolumeMm3 = 0;
    // The largest single item decides whether anything fits at all, however
    // small the total volume comes out.
    let longestEdgeMm = 0;
    let secondEdgeMm = 0;

    for (const line of lines) {
      const v = byId.get(line.productVariantId);
      const measured =
        v?.weightGrams != null &&
        v.lengthMm != null &&
        v.widthMm != null &&
        v.heightMm != null;
      if (!v || !measured) {
        unmeasuredVariantIds.push(line.productVariantId);
        continue;
      }
      totalWeightGrams += v.weightGrams! * line.quantity;
      totalVolumeMm3 += v.lengthMm! * v.widthMm! * v.heightMm! * line.quantity;

      const edges = [v.lengthMm!, v.widthMm!, v.heightMm!].sort((a, b) => b - a);
      longestEdgeMm = Math.max(longestEdgeMm, edges[0]!);
      secondEdgeMm = Math.max(secondEdgeMm, edges[1]!);
    }

    const cartons = await this.db
      .select()
      .from(invCartonTypes)
      .where(and(eq(invCartonTypes.orgId, orgId), eq(invCartonTypes.isActive, true)));

    const candidates = cartons
      .map((carton) => {
        const capacityVolumeMm3 =
          carton.innerLengthMm * carton.innerWidthMm * carton.innerHeightMm;
        const inner = [
          carton.innerLengthMm,
          carton.innerWidthMm,
          carton.innerHeightMm,
        ].sort((a, b) => b - a);

        const reasons: string[] = [];
        if (totalWeightGrams > carton.maxWeightGrams) {
          reasons.push(
            `${totalWeightGrams}g exceeds the ${carton.maxWeightGrams}g rating`,
          );
        }
        if (totalVolumeMm3 > capacityVolumeMm3) {
          reasons.push("contents exceed the carton's internal volume");
        }
        if (longestEdgeMm > inner[0]! || secondEdgeMm > inner[1]!) {
          reasons.push("an item is longer than the carton's internal dimensions");
        }

        return {
          cartonTypeId: carton.id,
          code: carton.code,
          name: carton.name,
          capacityWeightGrams: carton.maxWeightGrams,
          capacityVolumeMm3,
          fits: reasons.length === 0,
          reasons,
        } satisfies CartonCandidate;
      })
      // Smallest first: the cheapest box that works is the one to use, and
      // shipping air costs money on every parcel.
      .sort((a, b) => a.capacityVolumeMm3 - b.capacityVolumeMm3);

    return {
      totalWeightGrams,
      totalVolumeMm3,
      unmeasuredVariantIds,
      // With anything unmeasured the totals are lower bounds, so recommending a
      // carton would be asserting a fit computed from incomplete data.
      recommended:
        unmeasuredVariantIds.length > 0
          ? null
          : (candidates.find((c) => c.fits) ?? null),
      candidates,
    };
  }

  /**
   * Refuses a carton the contents demonstrably do not fit. Silent about the
   * unmeasured case: refusing to close a package because the catalogue is
   * incomplete would stop a warehouse working over a data-entry gap.
   */
  async assertFits(
    orgId: string,
    cartonTypeId: number,
    lines: readonly CartonizationLine[],
  ): Promise<void> {
    const result = await this.suggest(orgId, lines);
    const chosen = result.candidates.find((c) => c.cartonTypeId === cartonTypeId);
    if (!chosen) {
      throw new BadRequestException("That carton type is not available");
    }
    if (!chosen.fits) {
      throw new BadRequestException(
        `Contents do not fit ${chosen.code}: ${chosen.reasons.join("; ")}`,
      );
    }
  }
}
