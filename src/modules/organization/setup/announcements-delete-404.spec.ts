import { NotFoundException } from "@nestjs/common";
import { broadcastAudienceTargets, broadcasts } from "../../../db/schema";
import { AnnouncementsService } from "./announcements.service";
import {
  type Op,
  makeCache,
  makeDb,
} from "./__tests__/announcements-broadcast-double";

describe("AnnouncementsService.remove — a delete that matched nothing is a 404, not a 200", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function serviceOver(deleted: Array<{ id: number }>) {
    const ops: Op[] = [];
    const cache = makeCache();
    const db = makeDb(() => deleted, ops);
    return { svc: new AnnouncementsService(db, cache as never), ops, cache };
  }

  it("refuses an announcement id that belongs to another org", async () => {
    const { svc } = serviceOver([]);

    await expect(svc.remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("still deletes the caller's own announcement (control)", async () => {
    const { svc, ops } = serviceOver([{ id: 1 }]);

    await expect(svc.remove(OWNER_ORG, 1)).resolves.toBeUndefined();
    expect(ops.some((op) => op.kind === "delete" && op.table === broadcasts)).toBe(true);
  });

  it("clears the audience target rows with the broadcast, which has no cascading foreign key to lean on", async () => {
    const { svc, ops } = serviceOver([{ id: 1 }]);

    await svc.remove(OWNER_ORG, 1);

    expect(
      ops.some((op) => op.kind === "delete" && op.table === broadcastAudienceTargets),
    ).toBe(true);
  });

  it("leaves the caches alone when the delete matched nothing", async () => {
    const { svc, cache } = serviceOver([]);

    await expect(svc.remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(cache.invalidateForOrg).not.toHaveBeenCalled();
  });
});
