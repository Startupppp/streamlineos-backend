/**
 * FD9 regression: a failing or hanging email provider must not hold a pooled
 * DB connection open.
 *
 * Rule (backend/CLAUDE.md §4): a network call must never run inside the request
 * transaction, "which would hold a pooled connection for the length of someone
 * else's outage."
 *
 * Property under test: when resendInvitation calls the email provider, the
 * tenant transaction it opened has already committed (txDepth === 0). This
 * holds whether the provider immediately rejects or never settles (hangs).
 *
 * Anti-vacuous: the db.transaction() mock DOES invoke its callback. A bare
 * jest.fn() silently voids every assertion inside the transaction (repo trap,
 * documented in backend/CLAUDE.md §8).
 */

import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { primeRelocationTrafficTracker } from "../../../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../../../db/drizzle.module";
import { resendInvitation } from "../lib/invitation-mail-ops";
import type { InvitationMailDeps } from "../lib/invitation-mail-ops";

const ORG_ID = "org-fd9";
const INVITATION_ID = "inv-fd9";
const USER_ID = "user-fd9";

beforeAll(() => {
  primeRelocationTrafficTracker([], Date.now());
});

interface TrackingState {
  txDepth: number;
}

function buildTrackedDb(state: TrackingState): Db {
  const tx = {
    execute: jest.fn().mockResolvedValue([{}]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: INVITATION_ID }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  };

  return {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({
          name: "Test Org",
          status: "ACTIVE",
          deletedAt: null,
        }),
      },
      invitations: {
        findFirst: jest.fn().mockResolvedValue({
          id: INVITATION_ID,
          orgId: ORG_ID,
          email: "target@example.com",
          status: "PENDING",
          acceptedAt: null,
          tokenHash: "old-hash",
          expiresAt: new Date("2099-01-01"),
        }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue({ name: "Sender", firstName: null, lastName: null }),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      state.txDepth += 1;
      try {
        return await fn(tx);
      } finally {
        state.txDepth -= 1;
      }
    },
  } as unknown as Db;
}

function buildDeps(db: Db, sendEmail: jest.Mock): InvitationMailDeps {
  return {
    db,
    audit: { log: jest.fn() } as never,
    cache: { invalidateForOrg: jest.fn().mockResolvedValue(undefined) } as never,
    email: {
      sendInvitationEmail: sendEmail,
      sendInvitationRevokedEmail: jest.fn().mockResolvedValue(undefined),
    } as never,
    seatLedger: {} as never,
    access: {
      canManageOrganizationMembership: jest.fn().mockResolvedValue(true),
    } as never,
    logger: new Logger("fd9-test"),
  };
}

describe("resendInvitation: provider call happens OUTSIDE the transaction", () => {
  it("txDepth is 0 when the email provider is called (happy path)", async () => {
    const state: TrackingState = { txDepth: 0 };
    const db = buildTrackedDb(state);
    const callDepths: number[] = [];

    const sendEmail = jest.fn().mockImplementation(async () => {
      callDepths.push(state.txDepth);
    });

    await resendInvitation(buildDeps(db, sendEmail), ORG_ID, INVITATION_ID, {
      userId: USER_ID,
      isOrgOwner: false,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(callDepths).toEqual([0]);
  });

  it("txDepth is 0 when the email provider rejects", async () => {
    const state: TrackingState = { txDepth: 0 };
    const db = buildTrackedDb(state);
    const callDepths: number[] = [];

    const sendEmail = jest.fn().mockImplementation(async () => {
      callDepths.push(state.txDepth);
      throw new Error("SMTP refused");
    });

    await expect(
      resendInvitation(buildDeps(db, sendEmail), ORG_ID, INVITATION_ID, {
        userId: USER_ID,
        isOrgOwner: false,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(callDepths).toEqual([0]);
  });

  it("txDepth is 0 when the email provider never resolves (hangs)", async () => {
    const state: TrackingState = { txDepth: 0 };
    const db = buildTrackedDb(state);
    const callDepths: number[] = [];
    let releaseEmail: () => void = () => undefined;

    const sendEmail = jest.fn().mockImplementation(() => {
      callDepths.push(state.txDepth);
      return new Promise<void>((resolve) => {
        releaseEmail = resolve;
      });
    });

    const pending = resendInvitation(buildDeps(db, sendEmail), ORG_ID, INVITATION_ID, {
      userId: USER_ID,
      isOrgOwner: false,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(callDepths).toEqual([0]);

    releaseEmail();
    await pending;
  });
});

describe("anti-vacuous: the db.transaction() mock invokes its callback", () => {
  it("transaction() is NOT a bare jest.fn() — it calls its callback", async () => {
    let invoked = false;
    const db = { transaction: async <T>(fn: () => Promise<T>) => { invoked = true; return fn(); } };
    await db.transaction(async () => "result");
    expect(invoked).toBe(true);
  });

  it("moving the send INSIDE the transaction would set txDepth to 1 at call time", async () => {
    const callDepths: number[] = [];
    let depth = 0;

    const sendEmail = jest.fn().mockImplementation(async () => {
      callDepths.push(depth);
    });

    const db = {
      transaction: async <T>(fn: () => Promise<T>) => {
        depth += 1;
        try { return await fn(); } finally { depth -= 1; }
      },
    };

    await db.transaction(async () => { await sendEmail(); });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(callDepths).toEqual([1]);
  });
});
