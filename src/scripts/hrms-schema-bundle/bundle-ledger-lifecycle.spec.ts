import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "bundle-ledger-write.ts"),
  "utf8",
);

describe("HRMS schema bundle rollback lifecycle SQL", () => {
  it("resumes only an exact rolled-back operation and increments attempts", () => {
    expect(source).toContain("ON CONFLICT (operation_id) DO UPDATE");
    expect(source).toContain("attempts = operation.attempts + 1");
    expect(source).toContain("WHERE operation.state = 'ROLLED_BACK'");
    expect(source).toContain("operation.manifest_hash = EXCLUDED.manifest_hash");
    expect(source).toContain("operation.database_name = EXCLUDED.database_name");
    expect(source).toContain("operation.database_role = EXCLUDED.database_role");
    expect(source).toContain(
      "operation.server_version_num = EXCLUDED.server_version_num",
    );
  });

  it("durably records a failed rolled-back reapply", () => {
    expect(source).toContain("SET state = 'FAILED'");
    expect(source).toContain("attempts = attempts + 1");
    expect(source).toContain("AND state = 'ROLLED_BACK'");
    expect(source).toContain("last_error = ${failureCode}");
  });
});
