import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ReviewCyclesService } from "./review-cycles.service";

function makeDeleteChain(returning: unknown[]) {
  const returning_ = jest.fn().mockResolvedValue(returning);
  const where = jest.fn().mockReturnValue({ returning: returning_ });
  const delete_ = jest.fn().mockReturnValue({ where });
  const db = { delete: delete_ } as unknown as Db;
  return { db };
}

const OWN_ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002";

describe("ReviewCyclesService.deleteCycle — cross-tenant isolation", () => {
  it("deletes the cycle when it belongs to the caller's org (own → success)", async () => {
    const { db } = makeDeleteChain([{ id: 3 }]);
    const svc = new ReviewCyclesService(db, {} as never);
    await expect(svc.deleteCycle(OWN_ORG, 3)).resolves.toMatchObject({ success: true });
  });

  it("throws 404 when the cycle belongs to a different org (cross-tenant → 404)", async () => {
    const { db } = makeDeleteChain([]);
    const svc = new ReviewCyclesService(db, {} as never);
    await expect(svc.deleteCycle(OTHER_ORG, 3)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when the cycle id does not exist (unknown → 404)", async () => {
    const { db } = makeDeleteChain([]);
    const svc = new ReviewCyclesService(db, {} as never);
    await expect(svc.deleteCycle(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
  });
});
