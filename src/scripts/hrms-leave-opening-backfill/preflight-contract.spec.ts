import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/pending/hrms-phase1/preflight/02_leave_opening_balance_contract.sql",
  ),
  "utf8",
);

describe("leave opening SQL preflight contract", () => {
  it("requires the complete signed canonical registry shape", () => {
    for (const column of [
      "source_balance_id",
      "organization_id",
      "source_user_id",
      "source_year",
      "source_balance",
      "worker_id",
      "worker_engagement_id",
      "leave_type_id",
      "period_key",
      "effective_date",
    ])
      expect(sql).toContain(`('${column}',`);
    expect(sql).toContain(
      "FULL JOIN actual USING (column_name, data_type, not_null)",
    );
    expect(sql).toContain("attribute.attnotnull AS not_null");
  });

  it("checks source user and leave type against the legacy row", () => {
    expect(sql).toContain(
      "registry.source_user_id IS DISTINCT FROM source.user_id",
    );
    expect(sql).toContain(
      "registry.leave_type_id IS DISTINCT FROM source.leave_type_id",
    );
  });

  it("proves the canonical person, worker, engagement, and type tenant chain", () => {
    expect(sql).toContain("LEFT JOIN workers worker");
    expect(sql).toContain("LEFT JOIN organization_people person");
    expect(sql).toContain("person.user_id = registry.source_user_id");
    expect(sql).toContain("LEFT JOIN worker_engagements engagement");
    expect(sql).toContain("LEFT JOIN leave_types leave_type");
    expect(sql).toContain("HRMS_LEAVE_OPENING_CANONICAL_MAPPING_MISMATCH");
  });

  it("keeps the approved five-row 94.2000 baseline", () => {
    expect(sql).toContain("source_rows <> 5");
    expect(sql).toContain("source_total <> 94.20::numeric");
  });

  it("allows only a bounded opaque approval reference", () => {
    expect(sql).toContain(
      "approval_reference !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'",
    );
    expect(sql).toContain(
      "'app.hrms_leave_opening_approval_reference'",
    );
  });
});
