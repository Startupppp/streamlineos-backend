import {
  failureSummary,
  mayReportComplete,
  runAcrossRegions,
  type RegionWork,
} from "./subject-request";

const AT = () => new Date("2026-08-26T12:00:00.000Z");
const THREE_REGIONS = ["india", "eu", "us"] as const;

function work(counts: Record<string, number | Error>): RegionWork[] {
  return Object.entries(counts).map(([region, outcome]) => ({
    region,
    run: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  }));
}

describe("running across regions", () => {
  it("visits every configured region, not just the primary", async () => {
    // The single most important property here. A mocked single-region test would
    // report this as held while the EU copy of the subject's data survived.
    const result = await runAcrossRegions(
      "erasure",
      "subject@example.com",
      work({ india: 12, eu: 3, us: 0 }),
      AT,
    );

    expect(result.regions.map((r) => r.region)).toEqual(["india", "eu", "us"]);
    expect(result.complete).toBe(true);
  });

  it("counts zero as a real answer rather than a failure", async () => {
    // A subject with no data in a region is the common case, and treating it as
    // a failure would make every genuine erasure look partial.
    const result = await runAcrossRegions("erasure", "s@example.com", work({ eu: 0 }), AT);

    expect(result.regions[0]?.status).toBe("completed");
    expect(result.totalRecordsAffected).toBe(0);
  });

  it("keeps going when one region fails, and says which", async () => {
    // Stopping at the first failure leaves the rest in an unknown state rather
    // than a failed one.
    const result = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ india: 5, eu: new Error("connection refused"), us: 2 }),
      AT,
    );

    expect(result.regions).toHaveLength(3);
    expect(result.regions[1]).toMatchObject({ region: "eu", status: "failed" });
    expect(result.regions[2]).toMatchObject({ region: "us", status: "completed" });
  });

  it("is not complete when any region failed", async () => {
    const result = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ india: 5, eu: new Error("nope") }),
      AT,
    );

    expect(result.complete).toBe(false);
  });

  it("stamps each region with when it was actually done", async () => {
    const result = await runAcrossRegions("erasure", "s@example.com", work({ eu: 1 }), AT);
    expect(result.regions[0]?.at).toBe("2026-08-26T12:00:00.000Z");
  });

  it("refuses an empty enumeration rather than reporting success", async () => {
    // An empty enumeration reports success without having looked anywhere, which
    // is the worst possible answer to give a regulator.
    await expect(runAcrossRegions("erasure", "s@example.com", [], AT)).rejects.toThrow(
      /at least one region/,
    );
  });

  it("states when the last backup copy expires, rather than implying none exists", async () => {
    // You cannot reach into a backup generation to remove one subject without
    // invalidating the backup, so the honest answer is a date.
    const result = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ eu: 1 }),
      AT,
      "2026-11-24",
    );

    expect(result.backupsExpireBy).toBe("2026-11-24");
  });
});

describe("export is the same enumeration", () => {
  it("visits exactly the regions erasure visits", async () => {
    // Built separately, an export drifts from the erasure and only one of them
    // is ever exercised in anger.
    const erasure = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ india: 1, eu: 2, us: 3 }),
      AT,
    );
    const exported = await runAcrossRegions(
      "export",
      "s@example.com",
      work({ india: 1, eu: 2, us: 3 }),
      AT,
    );

    expect(exported.regions.map((r) => r.region)).toEqual(erasure.regions.map((r) => r.region));
    expect(exported.totalRecordsAffected).toBe(erasure.totalRecordsAffected);
  });

  it("carries its own kind, so a record says which was performed", async () => {
    const result = await runAcrossRegions("export", "s@example.com", work({ eu: 1 }), AT);
    expect(result.kind).toBe("export");
  });
});

describe("mayReportComplete", () => {
  it("agrees when every configured region was visited and succeeded", async () => {
    const result = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ india: 1, eu: 1, us: 1 }),
      AT,
    );

    expect(mayReportComplete(result, THREE_REGIONS)).toBe(true);
  });

  it("refuses when a configured region was never visited", async () => {
    // The failure mode this exists for: a region was added and the enumeration
    // was not updated. Every visited region succeeded, so `complete` is true --
    // and the subject's data is still in the region nobody looked at.
    const result = await runAcrossRegions("erasure", "s@example.com", work({ india: 1, eu: 1 }), AT);

    expect(result.complete).toBe(true);
    expect(mayReportComplete(result, THREE_REGIONS)).toBe(false);
  });

  it("refuses when a visited region failed", async () => {
    const result = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ india: 1, eu: new Error("x"), us: 1 }),
      AT,
    );

    expect(mayReportComplete(result, THREE_REGIONS)).toBe(false);
  });

  it("refuses when nothing is configured, rather than passing vacuously", async () => {
    const result = await runAcrossRegions("erasure", "s@example.com", work({ eu: 1 }), AT);
    expect(mayReportComplete(result, [])).toBe(false);
  });
});

describe("failureSummary", () => {
  it("is null when nothing failed", async () => {
    const result = await runAcrossRegions("erasure", "s@example.com", work({ eu: 1 }), AT);
    expect(failureSummary(result)).toBeNull();
  });

  it("names each failed region and why, for a record a regulator may read", async () => {
    const result = await runAcrossRegions(
      "erasure",
      "s@example.com",
      work({ india: new Error("timeout"), eu: 1, us: new Error("refused") }),
      AT,
    );

    expect(failureSummary(result)).toBe("india: timeout; us: refused");
  });
});
