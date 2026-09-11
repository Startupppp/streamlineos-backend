import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
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

function makePollDb(pollRow: Record<string, unknown>, voteRows: unknown[] = []) {
  let call = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? makeChainedBuilder([pollRow]) : makeChainedBuilder(voteRows);
    }),
  } as unknown as Db;
  return db;
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
    expect(result.counts).toHaveLength(2);
    expect(result.counts[0]).toEqual({ option: "Yes", optionIndex: 0, count: 3 });
    expect(result.counts[1]).toEqual({ option: "No", optionIndex: 1, count: 0 });
    expect(result.totalVotes).toBe(3);
  });
});
