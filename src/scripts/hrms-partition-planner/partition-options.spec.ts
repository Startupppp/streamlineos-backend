import { ZodError } from "zod";
import { parseCliOptions } from "./partition-options";

const now = new Date("2026-08-11T00:00:00Z");

describe("HRMS partition CLI options", () => {
  it("defaults to a database-free dry run", () => {
    expect(
      parseCliOptions(
        [
          "--environment=staging",
          "--tables=attendance_events",
          "--months=2026-08,2026-09",
          "--tenants=org-a,org-b",
        ],
        now,
        "test",
      ),
    ).toEqual({
      kind: "run",
      options: {
        apply: false,
        environment: "staging",
        tables: ["attendance_events"],
        months: ["2026-08", "2026-09"],
        tenantIds: ["org-a", "org-b"],
        hashModulus: null,
        manifestPath: null,
        manifestSha256: null,
        approvalId: null,
        applicationRole: null,
        migrationRole: null,
      },
    });
  });

  it("resolves the current and next-three month window", () => {
    const parsed = parseCliOptions(
      [
        "--environment=development",
        "--tables=worker_leave_ledger_entries",
        "--current-next-three",
      ],
      now,
      "development",
    );
    expect(parsed).toMatchObject({
      kind: "run",
      options: { months: ["2026-08", "2026-09", "2026-10", "2026-11"] },
    });
  });

  it("requires an explicit modulus for hash families", () => {
    expect(() =>
      parseCliOptions(
        [
          "--environment=staging",
          "--tables=worker_leave_entry_locators",
        ],
        now,
        "test",
      ),
    ).toThrow("--hash-modulus is required");
  });

  it("rejects a hash modulus outside the fixed registry", () => {
    expect(() =>
      parseCliOptions(
        [
          "--environment=staging",
          "--tables=attendance_correction_links",
          "--hash-modulus=8",
        ],
        now,
        "test",
      ),
    ).toThrow(ZodError);
  });

  it("rejects production apply without its separate acknowledgement", () => {
    expect(() =>
      parseCliOptions(
        [
          "--apply",
          "--environment=production",
          "--tables=hr_audit_events",
          "--months=2026-08",
          "--manifest=approved.json",
          `--manifest-sha256=${"a".repeat(64)}`,
          "--approval-id=APR_20260811_001",
          "--application-role=streamline_app",
          "--migration-role=streamline_hrms_migration",
        ],
        now,
        "production",
      ),
    ).toThrow("production apply requires --ack-production");
  });

  it("requires the manifest hash and approval ID as one complete set", () => {
    expect(() =>
      parseCliOptions(
        [
          "--environment=staging",
          "--tables=hr_audit_events",
          "--months=2026-08",
          "--manifest=approved.json",
        ],
        now,
        "test",
      ),
    ).toThrow("must be supplied together");
  });

  it("rejects a non-opaque approval ID", () => {
    expect(() =>
      parseCliOptions(
        [
          "--environment=staging",
          "--tables=hr_audit_events",
          "--months=2026-08",
          "--manifest=approved.json",
          `--manifest-sha256=${"a".repeat(64)}`,
          "--approval-id=Jane Doe <jane@example.invalid>",
          "--application-role=streamline_app",
          "--migration-role=streamline_hrms_migration",
        ],
        now,
        "test",
      ),
    ).toThrow(ZodError);
  });

  it("rejects tables outside the fixed registry", () => {
    expect(() =>
      parseCliOptions(
        [
          "--environment=staging",
          "--tables=users",
          "--months=2026-08",
        ],
        now,
        "test",
      ),
    ).toThrow(ZodError);
  });
});
