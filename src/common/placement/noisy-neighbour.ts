export interface OrgResourceSample {
  readonly organizationId: string;
  readonly used: number;
}

export const DISPROPORTIONATE_SHARE_THRESHOLD = 0.5;
export const CONSECUTIVE_WINDOWS_FOR_RELOCATION = 3;

type NoisyNeighbourKind = "THROTTLING_REVIEW" | "RELOCATION";

export interface ThrottlingReviewVerdict {
  readonly kind: "THROTTLING_REVIEW";
  readonly organizationId: string;
  readonly shareRatio: number;
}

export interface RelocationVerdict {
  readonly kind: "RELOCATION";
  readonly organizationId: string;
  readonly shareRatio: number;
  readonly consecutiveWindows: number;
}

export type NoisyNeighbourVerdict = ThrottlingReviewVerdict | RelocationVerdict;

export type NoisyNeighbourResult =
  | { readonly detected: false }
  | { readonly detected: true; readonly verdict: NoisyNeighbourVerdict };

function findHighestConsumer(
  samples: readonly OrgResourceSample[],
): OrgResourceSample | undefined {
  let worst: OrgResourceSample | undefined;
  for (const s of samples)
    if (worst === undefined || s.used > worst.used) worst = s;
  return worst;
}

export function detectNoisyNeighbour(
  samples: readonly OrgResourceSample[],
  priorConsecutiveWindows: number,
): NoisyNeighbourResult {
  if (samples.length === 0) return { detected: false };

  const totalUsed = samples.reduce((sum, s) => sum + s.used, 0);
  if (totalUsed === 0) return { detected: false };

  const worst = findHighestConsumer(samples);
  if (worst === undefined) return { detected: false };

  const shareRatio = worst.used / totalUsed;
  if (shareRatio < DISPROPORTIONATE_SHARE_THRESHOLD) return { detected: false };

  const consecutiveWindows = priorConsecutiveWindows + 1;

  if (consecutiveWindows >= CONSECUTIVE_WINDOWS_FOR_RELOCATION)
    return {
      detected: true,
      verdict: {
        kind: "RELOCATION",
        organizationId: worst.organizationId,
        shareRatio,
        consecutiveWindows,
      },
    };

  return {
    detected: true,
    verdict: {
      kind: "THROTTLING_REVIEW",
      organizationId: worst.organizationId,
      shareRatio,
    },
  };
}
