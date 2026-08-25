import { HrCalendarService } from "./hr-calendar.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CelebrationsService } from "../directory/celebrations.service";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    permissions: [],
    enabledModules: ["hr"],
    ...over,
  } as unknown as CurrentUserContext;
}

function makeDb(): Db {
  const chain: Record<string, jest.Mock> = {};
  chain["limit"] = jest.fn().mockResolvedValue([]);
  chain["where"] = jest.fn().mockReturnValue(chain);
  chain["leftJoin"] = jest.fn().mockReturnValue(chain);
  chain["from"] = jest.fn().mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

function makeAccess(holds: boolean): AccessService {
  return { holds: jest.fn().mockResolvedValue(holds) } as unknown as AccessService;
}

function makeCelebrations(): CelebrationsService {
  return { getAnniversaryFeed: jest.fn().mockResolvedValue([]) } as unknown as CelebrationsService;
}

describe("HrCalendarService — visibility checks via seam", () => {
  const travelOnly = { from: "2026-01-01", to: "2026-01-31", types: ["TRAVEL" as const] };
  const interviewOnly = { from: "2026-01-01", to: "2026-01-31", types: ["INTERVIEW" as const] };

  it("queries travel events when the seam grants hr:travel:view", async () => {
    const db = makeDb();
    const service = new HrCalendarService(db, makeCelebrations(), makeAccess(true));
    await service.getEvents(makeUser({}), travelOnly);
    expect(db.select).toHaveBeenCalled();
  });

  it("skips travel events when the seam denies hr:travel:view", async () => {
    const db = makeDb();
    const service = new HrCalendarService(db, makeCelebrations(), makeAccess(false));
    const events = await service.getEvents(makeUser({}), travelOnly);
    expect(events).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("queries interview events when the seam grants hr:interviews:view", async () => {
    const db = makeDb();
    const service = new HrCalendarService(db, makeCelebrations(), makeAccess(true));
    await service.getEvents(makeUser({}), interviewOnly);
    expect(db.select).toHaveBeenCalled();
  });

  it("skips interview events when the seam denies hr:interviews:view", async () => {
    const db = makeDb();
    const service = new HrCalendarService(db, makeCelebrations(), makeAccess(false));
    const events = await service.getEvents(makeUser({}), interviewOnly);
    expect(events).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("grants travel visibility to an org owner with no explicit permissions — seam is sole authority", async () => {
    const db = makeDb();
    const access = makeAccess(true);
    const service = new HrCalendarService(db, makeCelebrations(), access);
    await service.getEvents(makeUser({ isOrgOwner: true, permissions: [] }), travelOnly);
    expect(db.select).toHaveBeenCalled();
  });
});
