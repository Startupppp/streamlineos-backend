import { NotFoundException } from "@nestjs/common";
import { KbPageVisitsService } from "./kb-page-visits.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

describe("DELETE /kb/pages/:pageId/favorite — a delete that matched nothing is a 404", () => {
  function make(rows: Array<{ pageId: number }>) {
    const returning = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ returning });
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) } },
      delete: jest.fn().mockReturnValue({ where }),
    } as unknown as Db;
    return new KbPageVisitsService(db);
  }
  const user = { orgId: "org-attacker", userId: "u-1" } as CurrentUserContext;

  it("refuses a page the caller has not favourited", async () => {
    await expect(make([]).removeFavorite(user, 99)).rejects.toThrow(NotFoundException);
  });

  it("removes a favourite the caller does hold (control)", async () => {
    await expect(make([{ pageId: 99 }]).removeFavorite({ ...user, orgId: "org-owner" }, 99)).resolves.toEqual({
      success: true,
    });
  });
});
