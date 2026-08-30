import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { MeetingsService } from "./meetings.service";

describe("MeetingsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;

  function makeDb(meetingRow: unknown | null) {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(meetingRow), findMany: jest.fn().mockResolvedValue([]) },
      },
      select,
    } as unknown as Db;
  }

  it("throws NotFoundException when meeting belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new MeetingsService(db, audit);
    await expect(svc.getMeeting(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns meeting for the owning org (same-tenant control)", async () => {
    const meeting = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Standup" };
    const db = makeDb(meeting);
    const svc = new MeetingsService(db, audit);
    const result = await svc.getMeeting(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
