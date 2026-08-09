import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { DelegationsController } from "./delegations.controller";

describe("DelegationsController access contract", () => {
  it.each([
    "list",
    "listGiven",
    "create",
    "revoke",
  ] as const)("protects %s with the Settings RBAC permission", (method) => {
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSION,
        DelegationsController.prototype[method],
      ),
    ).toBe("settings:rbac:manage");
  });
});
