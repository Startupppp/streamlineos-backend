import { NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ANONYMITY_MIN_RESPONSES } from "../../../common/privacy/anonymity-threshold";
import type { Db } from "../../../db/drizzle.module";
import { hrMoodCheckins } from "../../../db/schema/hr/engagement-extras";
import { EngagementMoodPollsService } from "./engagement-mood-polls.service";

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(11, false),
};

function makeChainedBuilder(resolveWith: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "groupBy", "orderBy", "offset"]) {
    b[m] = jest.fn().mockReturnValue(b);
  }
  b["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveWith).then(resolve);
  return b;
}

function makePollDb(pollRow: Record<string, unknown> | undefined, voteRows: unknown[] = []) {
  let call = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? makeChainedBuilder(pollRow ? [pollRow] : []) : makeChainedBuilder(voteRows);
    }),
  } as unknown as Db;
  return db;
}

function makeMoodDb(rows: { date: string; mood: number }[]) {
  return { select: jest.fn().mockImplementation(() => makeChainedBuilder(rows)) } as unknown as Db;
}

function moodRows(date: string, moods: number[]) {
  return moods.map((mood) => ({ date, mood }));
}

describe("EngagementMoodPollsService", () => {
  it("upserts a member's daily mood against the existing membership uniqueness constraint", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const db = { insert: jest.fn().mockReturnValue({ values }) } as unknown as Db;
    const service = new EngagementMoodPollsService(db);

    await service.moodCheckin(actor, { date: "2026-09-01", mood: 4, note: "Focused" });

    expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: [hrMoodCheckins.orgId, hrMoodCheckins.userMembershipId, hrMoodCheckins.date],
      set: expect.objectContaining({ userMembershipId: 11 }),
    }));
  });
});

describe("EngagementMoodPollsService.pollResults — JSONB options boundary", () => {
  const basePoll = {
    id: 1, orgId: "org-1", question: "Q?", anonymous: false,
    status: "active", closesAt: null, createdAt: new Date(),
  };

  it("returns empty counts when options is a plain object instead of an array (seed defect)", async () => {
    const db = makePollDb({ ...basePoll, options: { a: "bad" } });
    const svc = new EngagementMoodPollsService(db);
    const result = await svc.pollResults("org-1", 1);
    expect(result.counts).toEqual([]);
    expect(result.totalVotes).toBe(0);
  });

  it("returns empty counts when options is null (non-conforming stored value)", async () => {
    const db = makePollDb({ ...basePoll, options: null });
    const svc = new EngagementMoodPollsService(db);
    const result = await svc.pollResults("org-1", 1);
    expect(result.counts).toEqual([]);
  });

  it("returns populated counts when options is a proper string array", async () => {
    const voteRows = [{ optionIndex: 0, count: 3 }];
    const db = makePollDb({ ...basePoll, options: ["Yes", "No"] }, voteRows);
    const svc = new EngagementMoodPollsService(db);
    const result = await svc.pollResults("org-1", 1);
    expect(result.counts).toEqual([
      { option: "Yes", optionIndex: 0, count: 3 },
      { option: "No", optionIndex: 1, count: 0 },
    ]);
    expect(result.totalVotes).toBe(3);
  });
});

describe("EngagementMoodPollsService.pollResults — anonymity threshold", () => {
  const anonymousPoll = {
    id: 1, orgId: "org-1", question: "Q?", anonymous: true, options: ["Yes", "No"],
    status: "active", closesAt: null, createdAt: new Date(),
  };

  it("hides the per-option breakdown of an anonymous poll with one fewer vote than the minimum, keeping only the total", async () => {
    const votes = ANONYMITY_MIN_RESPONSES - 1;
    const svc = new EngagementMoodPollsService(makePollDb(anonymousPoll, [{ optionIndex: 0, count: votes }]));

    const result = await svc.pollResults("org-1", 1);

    expect(result.suppressed).toBe(true);
    expect(result.counts).toBeNull();
    expect(result.totalVotes).toBe(votes);
    expect(result.minResponses).toBe(ANONYMITY_MIN_RESPONSES);
  });

  it("shows the breakdown of an anonymous poll once the minimum is reached", async () => {
    const svc = new EngagementMoodPollsService(
      makePollDb(anonymousPoll, [{ optionIndex: 0, count: ANONYMITY_MIN_RESPONSES - 1 }, { optionIndex: 1, count: 1 }]),
    );

    const result = await svc.pollResults("org-1", 1);

    expect(result.suppressed).toBe(false);
    expect(result.counts).toEqual([
      { option: "Yes", optionIndex: 0, count: ANONYMITY_MIN_RESPONSES - 1 },
      { option: "No", optionIndex: 1, count: 1 },
    ]);
  });

  it("does not suppress an anonymous poll nobody has voted on — zero counts reveal nobody", async () => {
    const svc = new EngagementMoodPollsService(makePollDb(anonymousPoll, []));

    const result = await svc.pollResults("org-1", 1);

    expect(result.suppressed).toBe(false);
    expect(result.counts).toEqual([
      { option: "Yes", optionIndex: 0, count: 0 },
      { option: "No", optionIndex: 1, count: 0 },
    ]);
  });

  it("never suppresses a poll that was not anonymous, whatever its size", async () => {
    const svc = new EngagementMoodPollsService(
      makePollDb({ ...anonymousPoll, anonymous: false }, [{ optionIndex: 1, count: 1 }]),
    );

    const result = await svc.pollResults("org-1", 1);

    expect(result.suppressed).toBe(false);
    expect(result.counts?.[1]).toEqual({ option: "No", optionIndex: 1, count: 1 });
  });

  it("answers 404 for a poll that belongs to another organisation, before reading any votes", async () => {
    const db = makePollDb(undefined, [{ optionIndex: 0, count: 1 }]);
    const svc = new EngagementMoodPollsService(db);

    await expect(svc.pollResults("org-attacker", 1)).rejects.toThrow(NotFoundException);
    expect((db as unknown as { select: jest.Mock }).select).toHaveBeenCalledTimes(1);
  });
});

describe("EngagementMoodPollsService.orgMoodAggregate — anonymity threshold", () => {
  it("drops a day with one fewer check-in than the minimum and counts it as suppressed, keeping a day at the minimum", async () => {
    const svc = new EngagementMoodPollsService(
      makeMoodDb([
        ...moodRows("2026-09-01", Array.from({ length: ANONYMITY_MIN_RESPONSES - 1 }, () => 2)),
        ...moodRows("2026-09-02", Array.from({ length: ANONYMITY_MIN_RESPONSES }, () => 4)),
      ]),
    );

    const result = await svc.orgMoodAggregate("org-1");

    expect(result.minResponses).toBe(ANONYMITY_MIN_RESPONSES);
    expect(result.suppressedDays).toBe(1);
    expect(result.points).toEqual([{ date: "2026-09-02", avgMood: 4, count: ANONYMITY_MIN_RESPONSES }]);
  });

  it("reports every day as suppressed rather than as no data when nobody's day reached the minimum", async () => {
    const svc = new EngagementMoodPollsService(makeMoodDb([...moodRows("2026-09-01", [1]), ...moodRows("2026-09-02", [5, 5])]));

    const result = await svc.orgMoodAggregate("org-1");

    expect(result.points).toEqual([]);
    expect(result.suppressedDays).toBe(2);
  });
});
