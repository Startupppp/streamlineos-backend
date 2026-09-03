import { NotFoundException } from "@nestjs/common";
import { AnnouncementsService } from "./announcements.service";
import type { Db } from "../../../db/drizzle.module";

describe("AnnouncementsService.remove — a delete that matched nothing is a 404, not a 200", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(deleted: Array<{ id: number }>) {
    const returning = jest.fn().mockResolvedValue(deleted);
    const where = jest.fn().mockReturnValue({ returning });
    return { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
  }

  it("refuses an announcement id that belongs to another org", async () => {
    const svc = new AnnouncementsService(makeDb([]));

    await expect(svc.remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("still deletes the caller's own announcement (control)", async () => {
    const svc = new AnnouncementsService(makeDb([{ id: 1 }]));

    await expect(svc.remove(OWNER_ORG, 1)).resolves.toBeUndefined();
  });
});
