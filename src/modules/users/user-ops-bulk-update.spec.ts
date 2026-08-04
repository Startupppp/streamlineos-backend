import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("UserOpsService bulk update transaction contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src", "modules", "users", "user-ops.service.ts"),
    "utf8",
  );
  const method = source.slice(
    source.indexOf("async bulkUpdateUsers("),
    source.indexOf("async sendSigninLink("),
  );

  it("keeps legacy, canonical employment, unit, and role writes together", () => {
    expect(method.match(/this\.db\.transaction/g)).toHaveLength(1);
    expect(method).toContain(".update(users)");
    expect(method).toContain(".update(hrEmployments)");
    expect(method).toContain(".update(organizationMembers)");
    expect(method).toContain(".insert(orgUnitMembers)");
  });

  it("uses bounded set writes for organization-unit movement", () => {
    expect(method).toContain("inArray(orgUnitMembers.id, existing.map");
    expect(method).toContain(".values(tenantUserIds.map");
    expect(method).not.toContain("for (const row of existing)");
  });
});
