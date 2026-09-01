import { CalendarService } from "./calendar.service";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";

function makeDb(memberRow: { id: number } | undefined, deletedRows: unknown[]) {
  const returning = jest.fn().mockResolvedValue(deletedRows);
  const tx = {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(memberRow) } },
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
  };
  return {
    db: {
      transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db,
    tx,
  };
}

function serviceWith(db: Db) {
  return new CalendarService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("CalendarService.deleteEvent — a miss must not report success", () => {
  it("returns null when the event belongs to another organisation", async () => {
    const { db } = makeDb({ id: 7 }, []);
    const service = serviceWith(db);

    const result = await service.deleteEvent(OTHER_ORG, USER, 42);

    expect(result).toBeNull();
  });

  it("returns null when no row matched, rather than { deleted: true }", async () => {
    const { db } = makeDb({ id: 7 }, []);
    const service = serviceWith(db);

    const result = await service.deleteEvent(ORG, USER, 999);

    expect(result).toBeNull();
  });

  it("returns null when the caller has no active membership, and issues no delete", async () => {
    const { db, tx } = makeDb(undefined, []);
    const service = serviceWith(db);

    const result = await service.deleteEvent(ORG, USER, 42);

    expect(result).toBeNull();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("reports success only when a row was actually removed", async () => {
    const { db } = makeDb({ id: 7 }, [{ integrationConnectionId: null, externalEventId: null }]);
    const service = serviceWith(db);

    const result = await service.deleteEvent(ORG, USER, 42);

    expect(result).toEqual({ deleted: true });
  });
});
