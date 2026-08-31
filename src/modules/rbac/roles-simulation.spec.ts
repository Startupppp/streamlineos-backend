import { NotFoundException } from "@nestjs/common";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { RolesController } from "./roles.controller";
import { RolesQueryService } from "./roles-query.service";
import type { Db } from "../../db/drizzle.module";

function makeQueryService(target: { isOwner: boolean } | undefined): RolesQueryService {
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(target),
      },
    },
  } as unknown as Db;
  return new RolesQueryService(db);
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
    const service = makeQueryService(undefined);
    await expect(service.getSimulationTarget("org-1", "user-2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns ownership only for the scoped active member", async () => {
    const service = makeQueryService({ isOwner: true });
    await expect(service.getSimulationTarget("org-1", "user-1")).resolves.toEqual({
      isOwner: true,
    });
  });
});
