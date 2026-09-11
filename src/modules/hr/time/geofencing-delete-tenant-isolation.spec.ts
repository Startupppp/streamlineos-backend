import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { GeofencingService } from "./geofencing.service";

function makeUpdateChain(returning: unknown[]) {
  const returning_ = jest.fn().mockResolvedValue(returning);
  const where = jest.fn().mockReturnValue({ returning: returning_ });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const db = { update } as unknown as Db;
  return { db, update, set, where, returning: returning_ };
}

const OWN_ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002";

describe("GeofencingService.remove — cross-tenant isolation", () => {
  it("soft-deletes the zone when it belongs to the caller's org (own → success)", async () => {
    const { db } = makeUpdateChain([{ id: 7 }]);
    const svc = new GeofencingService(db);
    await expect(svc.remove(OWN_ORG, 7)).resolves.toBeUndefined();
  });

  it("throws 404 when the zone belongs to a different org (cross-tenant → 404)", async () => {
    const { db } = makeUpdateChain([]);
    const svc = new GeofencingService(db);
    await expect(svc.remove(OTHER_ORG, 7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when the zone id does not exist in any org (unknown → 404)", async () => {
    const { db } = makeUpdateChain([]);
    const svc = new GeofencingService(db);
    await expect(svc.remove(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
  });
});
