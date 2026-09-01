import { InternalServerErrorException } from "@nestjs/common";
import { TimerService } from "../timer.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const MEMBERSHIP_ID = 42;

function makeCtx(): CurrentUserContext {
  return {
    orgId: "org-1",
    userId: "user-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: MEMBERSHIP_ID, isOrgOwner: false },
  };
}

const START_INPUT = {
  projectId: undefined,
  ticketId: undefined,
  description: "Testing",
  billable: false,
} as Parameters<TimerService["startTimer"]>[1];

function makeSelectChain(terminalRows: unknown[]) {
  const whereResult = Object.assign(Promise.resolve(terminalRows), {
    limit: jest.fn().mockResolvedValue(terminalRows),
  });
  const where = jest.fn().mockReturnValue(whereResult);
  const leftJoin2 = jest.fn().mockReturnValue({ where });
  const leftJoin1 = jest.fn().mockReturnValue({ leftJoin: leftJoin2, where });
  const from = jest.fn().mockReturnValue({ leftJoin: leftJoin1, where });
  return { from };
}

function makeDb(insertReturningRows: unknown[], selectRows: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(insertReturningRows);
  const insertValues = jest.fn().mockReturnValue({ returning });

  return {
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    select: jest.fn().mockReturnValue(makeSelectChain(selectRows)),
    query: {
      timerSessions: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  };
}

function makeSvc(db: unknown) {
  const mockEntries = {} as never;
  const mockAudit = { recordWithDb: jest.fn() } as never;
  return new TimerService(db as never, mockEntries, mockAudit);
}

describe("TimerService.startTimer — guard when insert returns no row", () => {
  it("throws InternalServerErrorException when insert().returning() yields an empty array", async () => {
    const db = makeDb([]);
    const svc = makeSvc(db);

    await expect(svc.startTimer(makeCtx(), START_INPUT)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it("throws InternalServerErrorException when fetchTimerWithRelations returns nothing after insert", async () => {
    const sessionRow = {
      id: 99,
      orgId: "org-1",
      userMembershipId: MEMBERSHIP_ID,
      projectId: null,
      ticketId: null,
      description: null,
      billable: false,
      startedAt: new Date(),
      lastResumedAt: new Date(),
      accumulatedSeconds: 0,
      status: "RUNNING",
      source: "WEB",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let selectCallCount = 0;
    const db = makeDb([sessionRow]);

    db.select = jest.fn().mockImplementation(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return makeSelectChain([]);
      return makeSelectChain([]);
    });

    const svc = makeSvc(db);

    await expect(svc.startTimer(makeCtx(), START_INPUT)).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});
