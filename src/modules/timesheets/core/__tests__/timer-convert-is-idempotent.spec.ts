import { ConflictException } from "@nestjs/common";
import { TimerService } from "../timer.service";
import type { Db } from "../../../../db/drizzle.types";
import type { EntriesService } from "../entries.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const MEMBERSHIP_ID = 1;

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "user",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
};

type TimerRow = {
  id: number;
  orgId: string;
  userMembershipId: number;
  status: string;
  accumulatedSeconds: number;
  lastResumedAt: Date | null;
  projectId: number | null;
  ticketId: number | null;
  description: string | null;
  billable: boolean;
};

function makeService(initial: TimerRow, createEntry: jest.Mock) {
  const stored: TimerRow = { ...initial };

  const db = {
    query: {
      timerSessions: {
        findFirst: jest.fn(() => Promise.resolve({ ...stored })),
      },
    },
    update: jest.fn(() => ({
      set: jest.fn((values: { status: string }) => ({
        where: jest.fn(() => {
          const claimable = ["STOPPED", "PAUSED"].includes(stored.status);
          const restoring = values.status === "PAUSED" && stored.status === "CONVERTED";
          const matched = values.status === "CONVERTED" ? claimable : restoring;
          if (matched) stored.status = values.status;
          const rows = matched ? [{ ...stored }] : [];
          return {
            returning: jest.fn(() => Promise.resolve(rows)),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),
  };

  const service = new TimerService(
    db as unknown as Db,
    { createEntry } as unknown as EntriesService,
    { recordWithDb: jest.fn().mockResolvedValue(undefined) } as unknown as TimesheetsAuditService,
  );
  return { service, stored };
}

const STOPPED_TIMER: TimerRow = {
  id: 9,
  orgId: actor.orgId,
  userMembershipId: MEMBERSHIP_ID,
  status: "STOPPED",
  accumulatedSeconds: 3600,
  lastResumedAt: new Date(Date.now() - 7200 * 1000),
  projectId: 4,
  ticketId: null,
  description: "QA smoke test",
  billable: true,
};

describe("converting a timer twice creates exactly one entry", () => {
  it("claims the CONVERTED transition before writing the entry, so a retry conflicts instead of duplicating", async () => {
    const createEntry = jest.fn().mockResolvedValue({ id: 100 });
    const { service } = makeService(STOPPED_TIMER, createEntry);

    await service.convertTimer(actor, 9, {});
    await expect(service.convertTimer(actor, 9, {})).rejects.toThrow(ConflictException);

    expect(createEntry).toHaveBeenCalledTimes(1);
  });

  it("leaves a recoverable paused timer when the entry write fails, rather than a converted one with no entry", async () => {
    const createEntry = jest.fn().mockRejectedValue(new Error("daily limit exceeded"));
    const { service, stored } = makeService(STOPPED_TIMER, createEntry);

    await expect(service.convertTimer(actor, 9, {})).rejects.toThrow("daily limit exceeded");

    expect(stored.status).toBe("PAUSED");
  });
});

describe("a paused timer converts the time it accumulated, not the wall clock since it was paused", () => {
  it("does not add the interval since lastResumedAt a second time", async () => {
    const createEntry = jest.fn().mockResolvedValue({ id: 101 });
    const pausedAnHourAgo: TimerRow = {
      ...STOPPED_TIMER,
      status: "PAUSED",
      accumulatedSeconds: 1800,
      lastResumedAt: new Date(Date.now() - 5400 * 1000),
    };
    const { service } = makeService(pausedAnHourAgo, createEntry);

    await service.convertTimer(actor, 9, {});

    expect(createEntry).toHaveBeenCalledWith(actor, expect.objectContaining({ hours: 0.5 }));
  });
});
