import { NotFoundException } from "@nestjs/common";
import { SupportMacrosService } from "./support-macros.service";
import type { Db } from "../../../db/drizzle.module";

describe("DELETE /support/vip-clients/:clientId — a delete that matched nothing is a 404", () => {
  function make(rows: Array<{ clientId: number }>) {
    const returning = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ returning });
    const db = { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
    return new SupportMacrosService(db);
  }

  it("refuses a client id the org has not marked VIP", async () => {
    await expect(make([]).removeVipClient("org-attacker", 1)).rejects.toThrow(NotFoundException);
  });

  it("removes the org's own VIP client (control)", async () => {
    await expect(make([{ clientId: 1 }]).removeVipClient("org-owner", 1)).resolves.toEqual({ success: true });
  });
});
