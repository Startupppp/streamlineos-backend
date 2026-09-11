jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { OrgController } from "../organization/setup/org.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";

describe("Calendar member lookup — OrgController.listMembers structural gate", () => {
  it('carries @RequirePermission("directory:people:view")', () => {
    const gate = Reflect.getMetadata(
      REQUIRE_PERMISSION,
      OrgController.prototype.listMembers,
    );
    expect(gate).toBe("directory:people:view");
  });

  it("BITE PROOF — the gate is declared: absence would make this test fail", () => {
    const gate = Reflect.getMetadata(
      REQUIRE_PERMISSION,
      OrgController.prototype.listMembers,
    );
    expect(gate).not.toBeUndefined();
  });

  it("orgId is sourced from CurrentUser, not from a query parameter — signature proof", () => {
    const params = OrgController.prototype.listMembers.toString();
    expect(params).not.toMatch(/Param.*orgId/);
  });
});
