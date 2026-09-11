import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { EmergencyService } from "./emergency.service";

function makeDb(event: unknown) {
  const eventFindFirst = jest.fn().mockResolvedValue(event);
  const responseFindFirst = jest.fn().mockResolvedValue(undefined);
  const returning_ = jest.fn().mockResolvedValue([{ id: 1 }]);
  const values_ = jest.fn().mockReturnValue({ returning: returning_ });
  const db = {
    query: {
      hrEmergencyEvents: { findFirst: eventFindFirst },
      hrEmergencyResponses: { findFirst: responseFindFirst },
    },
    insert: jest.fn().mockReturnValue({ values: values_ }),
  } as unknown as Db;
  return { db };
}

const OWN_ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_ID = "user-0001";
const EVENT_ID = "event-uuid-0001";

const body = { status: "safe" as const };

describe("EmergencyService.respond — cross-tenant isolation", () => {
  it("records response when the event belongs to the caller's org (own → success)", async () => {
    const { db } = makeDb({ id: EVENT_ID, orgId: OWN_ORG });
    const svc = new EmergencyService(db, {} as never);
    await expect(svc.respond(OWN_ORG, EVENT_ID, USER_ID, body)).resolves.toBeDefined();
  });

  it("throws 404 when the event belongs to a different org (cross-tenant → 404)", async () => {
    const { db } = makeDb(undefined);
    const svc = new EmergencyService(db, {} as never);
    await expect(svc.respond(OTHER_ORG, EVENT_ID, USER_ID, body)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when the event id does not exist (unknown → 404)", async () => {
    const { db } = makeDb(undefined);
    const svc = new EmergencyService(db, {} as never);
    await expect(svc.respond(OWN_ORG, "nonexistent", USER_ID, body)).rejects.toBeInstanceOf(NotFoundException);
  });
});
