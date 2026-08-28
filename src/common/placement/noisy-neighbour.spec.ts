import {
  CONSECUTIVE_WINDOWS_FOR_RELOCATION,
  DISPROPORTIONATE_SHARE_THRESHOLD,
  detectNoisyNeighbour,
} from "./noisy-neighbour";
import type { OrgResourceSample } from "./noisy-neighbour";

function sample(organizationId: string, used: number): OrgResourceSample {
  return { organizationId, used };
}

describe("detectNoisyNeighbour", () => {
  it("returns not detected when samples are empty", () => {
    expect(detectNoisyNeighbour([], 0).detected).toBe(false);
  });

  it("returns not detected when total used is zero", () => {
    const result = detectNoisyNeighbour([sample("org-1", 0), sample("org-2", 0)], 0);
    expect(result.detected).toBe(false);
  });

  it("returns not detected when no org exceeds the disproportionate share threshold", () => {
    const samples = [
      sample("org-1", 30),
      sample("org-2", 30),
      sample("org-3", 40),
    ];
    expect(detectNoisyNeighbour(samples, 0).detected).toBe(false);
  });

  it("returns THROTTLING_REVIEW for a single spike (first occurrence)", () => {
    const samples = [sample("org-noisy", 80), sample("org-quiet", 10)];
    const result = detectNoisyNeighbour(samples, 0);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.verdict.kind).toBe("THROTTLING_REVIEW");
      expect(result.verdict.organizationId).toBe("org-noisy");
    }
  });

  it("does NOT escalate to RELOCATION for a single spike", () => {
    const samples = [sample("org-noisy", 80), sample("org-quiet", 10)];
    const result = detectNoisyNeighbour(samples, 0);
    expect(result.detected).toBe(true);
    if (result.detected) expect(result.verdict.kind).not.toBe("RELOCATION");
  });

  it("returns THROTTLING_REVIEW when prior windows are below the escalation threshold", () => {
    const samples = [sample("org-noisy", 80), sample("org-quiet", 10)];
    const result = detectNoisyNeighbour(samples, CONSECUTIVE_WINDOWS_FOR_RELOCATION - 2);
    expect(result.detected).toBe(true);
    if (result.detected) expect(result.verdict.kind).toBe("THROTTLING_REVIEW");
  });

  it("escalates to RELOCATION when sustained over the required number of consecutive windows", () => {
    const samples = [sample("org-noisy", 80), sample("org-quiet", 10)];
    const priorWindows = CONSECUTIVE_WINDOWS_FOR_RELOCATION - 1;
    const result = detectNoisyNeighbour(samples, priorWindows);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.verdict.kind).toBe("RELOCATION");
      if (result.verdict.kind === "RELOCATION")
        expect(result.verdict.consecutiveWindows).toBe(CONSECUTIVE_WINDOWS_FOR_RELOCATION);
    }
  });

  it("identifies the organization consuming the largest share", () => {
    const samples = [
      sample("org-a", 10),
      sample("org-b", 70),
      sample("org-c", 10),
    ];
    const result = detectNoisyNeighbour(samples, 0);
    expect(result.detected).toBe(true);
    if (result.detected) expect(result.verdict.organizationId).toBe("org-b");
  });

  it("reports the share ratio of the flagged organization", () => {
    const samples = [sample("org-noisy", 80), sample("org-quiet", 20)];
    const result = detectNoisyNeighbour(samples, 0);
    expect(result.detected).toBe(true);
    if (result.detected)
      expect(result.verdict.shareRatio).toBeCloseTo(
        80 / 100,
        5,
      );
  });

  it("threshold constant is above 0.5 exclusive", () => {
    expect(DISPROPORTIONATE_SHARE_THRESHOLD).toBeGreaterThan(0);
    expect(DISPROPORTIONATE_SHARE_THRESHOLD).toBeLessThan(1);
  });
});
