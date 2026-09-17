import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../../common/ratelimit/use-rate-limit.decorator";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { createEmployeeExportJobSchema } from "./dto/export-job.dto";
import { HrExportController } from "./hr-export.controller";
import {
  serializeEmployeeExportHeader,
  serializeEmployeeExportRow,
} from "./hr-export-csv";
import {
  isExportScopeStillAllowed,
  isHrExportWorkerEnabled,
  narrowestExportScope,
} from "./hr-export-jobs.types";

describe("HR employee export", () => {
  it("enables the export worker by default (opt-out, matching payroll/expense)", () => {
    const previous = process.env.HR_EXPORT_WORKER_ENABLED;
    delete process.env.HR_EXPORT_WORKER_ENABLED;
    expect(isHrExportWorkerEnabled()).toBe(true);
    process.env.HR_EXPORT_WORKER_ENABLED = "false";
    expect(isHrExportWorkerEnabled()).toBe(false);
    process.env.HR_EXPORT_WORKER_ENABLED = "true";
    expect(isHrExportWorkerEnabled()).toBe(true);
    if (previous === undefined) delete process.env.HR_EXPORT_WORKER_ENABLED;
    else process.env.HR_EXPORT_WORKER_ENABLED = previous;
  });

  it("validates and normalizes bounded employee filters", () => {
    expect(
      createEmployeeExportJobSchema.parse({
        filters: { search: "  Ada  ", isActive: "all", role: "MEMBER" },
      }),
    ).toEqual({ filters: { search: "Ada", isActive: "all", role: "MEMBER" } });
    expect(() =>
      createEmployeeExportJobSchema.parse({ filters: { unknown: "value" } }),
    ).toThrow();
  });

  it("escapes CSV values and neutralizes spreadsheet formulas", () => {
    expect(serializeEmployeeExportHeader().startsWith("\uFEFF\"Name\"")).toBe(true);
    const row = serializeEmployeeExportRow({
      name: '=HYPERLINK("https://invalid.example")',
      email: "ada@example.com",
      employeeId: "EMP,1",
      designation: 'Engineer "II"',
      role: "MEMBER",
      department: "R&D",
      status: "Active",
    });
    expect(row).toContain("\"'=HYPERLINK(\"\"https://invalid.example\"\")\"");
    expect(row).toContain("\"EMP,1\"");
    expect(row).toContain("\"Engineer \"\"II\"\"\"");
  });

  it("never widens the employee scope captured at request time", () => {
    expect(narrowestExportScope("team", "all")).toBe("team");
    expect(narrowestExportScope("all", "own")).toBe("own");
    expect(narrowestExportScope("team", "none")).toBe("none");
    expect(isExportScopeStillAllowed("team", "all")).toBe(true);
    expect(isExportScopeStillAllowed("all", "team")).toBe(false);
  });

  it("uses the exact permission, rate tier, and idempotency fence", () => {
    const createHandler = HrExportController.prototype.create;
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, createHandler) ?? [];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, HrExportController)).toBe(
      "hr:export:manage",
    );
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, createHandler)).toBe(
      "hr.employee-export.create",
    );
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, createHandler)).toBe("hr:employee-export");
    expect(guards).toContain(RateLimitGuard);

    const downloadHandler = HrExportController.prototype.download;
    const downloadGuards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, downloadHandler) ?? [];
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, downloadHandler)).toBe(
      "hr:employee-export",
    );
    expect(downloadGuards).toContain(RateLimitGuard);
  });

  it("fails closed on the legacy synchronous employee export", () => {
    const legacyService = readFileSync(
      resolve(process.cwd(), "src", "modules", "hr", "import", "hr-import.service.ts"),
      "utf8",
    );
    expect(legacyService).toContain("HR_EMPLOYEE_EXPORT_ASYNC_REQUIRED");
    expect(legacyService).not.toContain("if (entity === \"employees\") {\n      return this.db");
  });

  it("keeps the deployment-gated migration reversible and verifiable", () => {
    const migrationRoot = resolve(process.cwd(), "migrations", "pending", "hr-export");
    const forward = readFileSync(resolve(migrationRoot, "0399_hr_export_jobs.sql"), "utf8");
    const rollback = readFileSync(
      resolve(migrationRoot, "0399_hr_export_jobs.down.sql"),
      "utf8",
    );
    const backfill = readFileSync(
      resolve(migrationRoot, "0399_hr_export_jobs.backfill.sql"),
      "utf8",
    );
    const verification = readFileSync(
      resolve(migrationRoot, "0399_hr_export_jobs.verify.sql"),
      "utf8",
    );
    expect(forward).toContain("CREATE TABLE hr_export_jobs");
    expect(forward).toContain("FORCE ROW LEVEL SECURITY");
    expect(forward).toContain("uniq_hr_export_jobs_org_idempotency");
    expect(rollback).toContain("HR_EXPORT_ROLLBACK_REFUSED_NONEMPTY_TABLE");
    expect(backfill).toContain("HR_EXPORT_BACKFILL_REFUSED_TABLE_MISSING");
    expect(verification).toContain("HR_EXPORT_VERIFY_RLS_NOT_FORCED");
  });
});
