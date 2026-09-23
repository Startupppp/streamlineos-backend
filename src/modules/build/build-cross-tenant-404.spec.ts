import { NotFoundException } from "@nestjs/common";
import { CyclesService } from "./execution/cycles.service";
import { ModulesService } from "./execution/modules.service";
import { BuildMembersService } from "./core/build-members.service";
import type { Db } from "../../db/drizzle.module";


function txDb(deleted: Array<{ id: number }>) {
  const returning = jest.fn().mockResolvedValue(deleted);
  const deleteWhere = jest.fn().mockReturnValue({ returning });
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const tx = {
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
  };
  return {
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
    transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;
}

describe("build — a delete that matched no row answers 404, not 204", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("DELETE /build/:projectId/cycles/:cycleId refuses a cycle the org does not own", async () => {
    await expect(new CyclesService(txDb([])).deleteCycle(ATTACKER_ORG, 1, 1)).rejects.toThrow(NotFoundException);
  });

  it("DELETE /build/:projectId/cycles/:cycleId still deletes the org's own cycle (control)", async () => {
    await expect(new CyclesService(txDb([{ id: 1 }])).deleteCycle(OWNER_ORG, 1, 1)).resolves.toEqual({ success: true });
  });

  it("DELETE /build/:projectId/modules/:moduleId refuses a module the org does not own", async () => {
    await expect(new ModulesService(txDb([])).deleteModule(ATTACKER_ORG, 1, 1)).rejects.toThrow(NotFoundException);
  });

  it("DELETE /build/:projectId/modules/:moduleId still deletes the org's own module (control)", async () => {
    await expect(new ModulesService(txDb([{ id: 1 }])).deleteModule(OWNER_ORG, 1, 1)).resolves.toEqual({
      success: true,
    });
  });

  describe("DELETE /build/members/:userId", () => {
    function make(orgMember: Array<{ id: number }>) {
      const limit = jest.fn().mockResolvedValue(orgMember);
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where });
      const tx = {
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      };
      const db = {
        select: jest.fn().mockReturnValue({ from }),
        transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
      } as unknown as Db;
      return new BuildMembersService(
        db,
        { log: jest.fn() } as unknown as ConstructorParameters<typeof BuildMembersService>[1],
      );
    }

    it("refuses a userId that is not a member of the caller's org", async () => {
      await expect(make([]).remove(ATTACKER_ORG, "actor", "victim")).rejects.toThrow(NotFoundException);
    });

    it("removes a member of the caller's own org (control)", async () => {
      await expect(make([{ id: 7 }]).remove(OWNER_ORG, "actor", "victim")).resolves.toBeUndefined();
    });
  });
});
