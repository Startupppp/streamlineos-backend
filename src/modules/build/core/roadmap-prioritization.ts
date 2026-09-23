export const RICE_METHOD = "rice";

export const RICE_REACH_MIN = 0;
export const RICE_REACH_MAX = 1_000_000;
export const RICE_IMPACT_MIN = 1;
export const RICE_IMPACT_MAX = 5;
export const RICE_CONFIDENCE_MIN = 0;
export const RICE_CONFIDENCE_MAX = 100;
export const RICE_CONFIDENCE_SCALE = 100;
export const RICE_EFFORT_MIN = 1;
export const RICE_EFFORT_MAX = 10_000;
export const RICE_SCORE_DECIMALS = 2;

export const RICE_INPUT_NAMES = ["reach", "impact", "confidence", "effort"] as const;
export type RiceInputName = (typeof RICE_INPUT_NAMES)[number];

export const RICE_SCORE_UNAVAILABLE_REASONS = ["missing_inputs", "non_positive_effort"] as const;
export type RiceScoreUnavailableReason = (typeof RICE_SCORE_UNAVAILABLE_REASONS)[number];

export type RiceInputs = {
  [K in RiceInputName]?: number | null;
};

export interface RoadmapPrioritization {
  method: typeof RICE_METHOD;
  score: number | null;
  isComplete: boolean;
  missingInputs: RiceInputName[];
  unavailableReason: RiceScoreUnavailableReason | null;
}

function roundToScoreDecimals(value: number): number {
  const factor = 10 ** RICE_SCORE_DECIMALS;
  return Math.round(value * factor) / factor;
}

export function computeRoadmapPrioritization(inputs: RiceInputs): RoadmapPrioritization {
  const missingInputs = RICE_INPUT_NAMES.filter((name) => {
    const value = inputs[name];
    return value === null || value === undefined || !Number.isFinite(value);
  });

  if (missingInputs.length > 0)
    return {
      method: RICE_METHOD,
      score: null,
      isComplete: false,
      missingInputs,
      unavailableReason: "missing_inputs",
    };

  const reach = Number(inputs.reach);
  const impact = Number(inputs.impact);
  const confidence = Number(inputs.confidence);
  const effort = Number(inputs.effort);

  if (effort <= 0)
    return {
      method: RICE_METHOD,
      score: null,
      isComplete: false,
      missingInputs: [],
      unavailableReason: "non_positive_effort",
    };

  const score = roundToScoreDecimals(
    (reach * impact * (confidence / RICE_CONFIDENCE_SCALE)) / effort,
  );

  return {
    method: RICE_METHOD,
    score,
    isComplete: true,
    missingInputs: [],
    unavailableReason: null,
  };
}
