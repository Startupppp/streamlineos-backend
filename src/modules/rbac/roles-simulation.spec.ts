import { NotFoundException } from "@nestjs/common";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";

function makeService(target: { isOwner: boolean } | undefined): RolesService {
  const service = Object.create(RolesService.prototype) as RolesService;
  Reflect.set(service, "db", {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(target),
      },
    },
  });
  return service;
}

describe("role permission simulation", () => {
  it("requires RBAC management for candidates and simulation", () => {
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSION,
        RolesController.prototype.listSimulationCandidates,
      ),
    ).toBe("settings:rbac:manage");
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, RolesController.prototype.simulateAccess),
    ).toBe("settings:rbac:manage");
  });

  it("rejects targets without an active membership in the organization", async () => {
    const service = makeService(undefined);
    await expect(service.getSimulationTarget("org-1", "user-2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns ownership only for the scoped active member", async () => {
    const service = makeService({ isOwner: true });
    await expect(service.getSimulationTarget("org-1", "user-1")).resolves.toEqual({
      isOwner: true,
    });
  });
});
