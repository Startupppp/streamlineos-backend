jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { IntegrationsController } from "./integrations.controller";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";

describe("IntegrationsController RBAC metadata", () => {
  const expectations: ReadonlyArray<[keyof IntegrationsController, string]> = [
    ["listConnections", "integrations:connections:view"],
    ["initiate", "integrations:connections:manage"],
    ["finalize", "integrations:connections:manage"],
    ["disconnect", "integrations:connections:manage"],
    ["setPrimary", "integrations:connections:manage"],
  ];

  it.each(expectations)("%s requires %s", (method, permission) => {
    const handler = IntegrationsController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(permission);
  });
});
