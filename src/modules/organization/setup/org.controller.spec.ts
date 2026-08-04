import { GUARDS_METADATA } from "@nestjs/common/constants";
import { PermissionGuard } from "../../access/permission.guard";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { OrgController } from "./org.controller";

describe("OrgController", () => {
  it("protects the member directory with directory view permission", () => {
    const handler = OrgController.prototype.listMembers;
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];

    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(
      "directory:people:view",
    );
    expect(guards).toContain(PermissionGuard);
  });
});
