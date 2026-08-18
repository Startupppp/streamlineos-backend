import { parseBundleOptions } from "./bundle-options";

describe("HRMS schema bundle CLI options", () => {
  it("defaults to a database-free dry run", () => {
    expect(parseBundleOptions([])).toEqual({
      kind: "run",
      options: {
        apply: false,
        rollback: false,
        rollbackThrough: null,
        manifestPath: null,
        manifestSha256: null,
        acknowledgeProduction: false,
      },
    });
  });

  it("accepts a paired manifest for local dry-run validation", () => {
    expect(
      parseBundleOptions([
        "--manifest=approval.json",
        `--manifest-sha256=${"a".repeat(64)}`,
      ]),
    ).toMatchObject({
      kind: "run",
      options: { apply: false, manifestPath: "approval.json" },
    });
  });

  it("requires an approval manifest for apply", () => {
    expect(() => parseBundleOptions(["--apply"])).toThrow(
      "RUNNER_APPLY_MANIFEST_REQUIRED",
    );
  });

  it("requires an exact rollback endpoint and approval manifest", () => {
    expect(() => parseBundleOptions(["--rollback"])).toThrow(
      "RUNNER_ROLLBACK_SCOPE_REQUIRED",
    );
    expect(() =>
      parseBundleOptions([
        "--rollback",
        "--rollback-through=0002_hrms_leave_ledger.sql",
      ]),
    ).toThrow("RUNNER_ROLLBACK_MANIFEST_REQUIRED");
  });

  it("accepts a hash-bound rollback action", () => {
    expect(
      parseBundleOptions([
        "--rollback",
        "--rollback-through=0002_hrms_leave_ledger.sql",
        "--manifest=rollback.json",
        `--manifest-sha256=${"c".repeat(64)}`,
      ]),
    ).toMatchObject({
      kind: "run",
      options: {
        apply: false,
        rollback: true,
        rollbackThrough: "0002_hrms_leave_ledger.sql",
      },
    });
  });

  it("rejects an unpaired manifest hash", () => {
    expect(() =>
      parseBundleOptions([`--manifest-sha256=${"b".repeat(64)}`]),
    ).toThrow("RUNNER_MANIFEST_PAIR_REQUIRED");
  });

  it("rejects production acknowledgement in dry-run mode", () => {
    expect(() => parseBundleOptions(["--ack-production"])).toThrow(
      "RUNNER_ACK_WITHOUT_APPLY",
    );
  });
});
