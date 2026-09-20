import { InternalServerErrorException } from "@nestjs/common";
import { OnboardingSessionService } from "./onboarding-session.service";

const ORG_ID = "org-race";
const USER_ID = "user-race";
const MEMBERSHIP_ID = 42;

type PartialSession = {
  id: number;
  orgId: string;
  userId: string;
  membershipId: number | null;
  type: string;
  status: string;
  data: Record<string, unknown>;
  completedSteps: string[];
  skippedSteps: string[];
  currentStep: string | null;
  source: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function makeInsertMock(returnedRows: PartialSession[]) {
  return jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(returnedRows),
      }),
    }),
  });
}

function makeService(
  findFirstResponses: (PartialSession | undefined)[],
  insertReturnedRows: PartialSession[],
) {
  const findFirst = jest.fn();
  for (const response of findFirstResponses)
    findFirst.mockResolvedValueOnce(response);

  const db = {
    query: { onboardingFlowSessions: { findFirst } },
    insert: makeInsertMock(insertReturnedRows),
  };

  const analytics = { track: jest.fn().mockResolvedValue(undefined) };
  const service = new OnboardingSessionService(db as never, analytics as never);
  return { service, db, analytics };
}

describe("getOrCreateSession concurrent-insert race (W1 fix)", () => {
  it("two concurrent first accesses yield exactly one session row, not two: the loser re-reads and returns the winner row", async () => {
    const winnerRow: PartialSession = {
      id: 1,
      orgId: ORG_ID,
      userId: USER_ID,
      membershipId: MEMBERSHIP_ID,
      type: "employee_onboarding",
      status: "not_started",
      data: {},
      completedSteps: [],
      skippedSteps: [],
      currentStep: null,
      source: null,
      startedAt: new Date(),
      completedAt: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { service, db, analytics } = makeService(
      [undefined, winnerRow],
      [],
    );

    const result = await service.getOrCreateSession(ORG_ID, USER_ID, "employee_onboarding", MEMBERSHIP_ID);

    expect(result).toBe(winnerRow);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.query.onboardingFlowSessions.findFirst).toHaveBeenCalledTimes(2);
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it("a successful first insert returns the new session and emits the started analytics event", async () => {
    const newRow: PartialSession = {
      id: 2,
      orgId: ORG_ID,
      userId: USER_ID,
      membershipId: MEMBERSHIP_ID,
      type: "member_setup",
      status: "not_started",
      data: {},
      completedSteps: [],
      skippedSteps: [],
      currentStep: null,
      source: null,
      startedAt: new Date(),
      completedAt: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { service, db, analytics } = makeService([undefined], [newRow]);

    const result = await service.getOrCreateSession(ORG_ID, USER_ID, "member_setup", MEMBERSHIP_ID);

    expect(result).toBe(newRow);
    expect(analytics.track).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      "member_setup_started",
      expect.objectContaining({ source: "session" }),
    );
    expect(db.query.onboardingFlowSessions.findFirst).toHaveBeenCalledTimes(1);
  });

  it("throws InternalServerErrorException when the race re-read finds no session, indicating a data integrity failure", async () => {
    const { service } = makeService([undefined, undefined], []);

    await expect(
      service.getOrCreateSession(ORG_ID, USER_ID, "org_setup", null),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
