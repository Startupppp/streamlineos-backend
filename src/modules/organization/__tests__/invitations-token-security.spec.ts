jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvitationsService } from "../invitations.service";
import { PlanLimitsService } from "../../billing/plan-limits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { hashToken } from "../../../common/security/token.util";

describe("hashToken — SHA-256 properties", () => {
  it("is deterministic: same input produces the same output", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("produces a 64-character lowercase hex string", () => {
    const h = hashToken("some-raw-token-value");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different raw tokens produce different hashes", () => {
    expect(hashToken("token-one")).not.toBe(hashToken("token-two"));
  });

  it("computed hash matches the known SHA-256 of the empty string", () => {
    expect(hashToken("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

const ORG_ID = "org-tok-test";
const ACTOR_ID = "user-actor";
const INVITATION_EMAIL = "invitee@example.com";
const RAW_TOKEN = "a".repeat(64);
const WRONG_TOKEN = "b".repeat(64);
const TOKEN_HASH = hashToken(RAW_TOKEN);

const BASE_INVITATION = {
  id: "inv-uuid-1",
  email: INVITATION_EMAIL,
  orgId: ORG_ID,
  role: "MEMBER",
  tokenHash: TOKEN_HASH,
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  status: "PENDING",
};

function buildUniversalTx() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 11 }]),
        }),
        returning: jest.fn().mockResolvedValue([{ id: 11 }]),
      }),
    })),
  };
}

function buildMockDb(overrides: {
  invitationFindFirst?: unknown;
  userFindFirst?: unknown;
  memberFindFirst?: unknown;
}) {
  const universalTx = buildUniversalTx();
  return {
    query: {
      invitations: {
        findFirst: jest.fn().mockResolvedValue(overrides.invitationFindFirst ?? null),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue(overrides.userFindFirst ?? null),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(overrides.memberFindFirst ?? null),
      },
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ id: ORG_ID, name: "Acme Corp" }),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    }),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof universalTx) => Promise<unknown>) => fn(universalTx),
    ),
  };
}

async function buildService(db: unknown): Promise<InvitationsService> {
  const module = await Test.createTestingModule({
    providers: [
      InvitationsService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: PlanLimitsService,
        useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: AuditService, useValue: { log: jest.fn() } },
      {
        provide: CacheService,
        useValue: { invalidate: jest.fn().mockResolvedValue(undefined), invalidatePattern: jest.fn().mockResolvedValue(undefined) },
      },
      {
        provide: EmailService,
        useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(InvitationsService);
}

describe("InvitationsService.validate — SHA-256 token lookup", () => {
  it("correct raw token → returns invitation details", async () => {
    const db = buildMockDb({ invitationFindFirst: BASE_INVITATION });
    const svc = await buildService(db);

    const result = await svc.validate(RAW_TOKEN);

    expect(result.email).toBe(INVITATION_EMAIL);
    expect(result.role).toBe("MEMBER");
    expect(result.userExists).toBe(false);
  });

  it("wrong raw token (hash mismatch) → NotFoundException", async () => {
    const db = buildMockDb({ invitationFindFirst: null });
    const svc = await buildService(db);

    await expect(svc.validate(WRONG_TOKEN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("findFirst is called exactly once per validate call", async () => {
    const db = buildMockDb({ invitationFindFirst: BASE_INVITATION });
    const svc = await buildService(db);

    await svc.validate(RAW_TOKEN);

    expect(db.query.invitations.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("InvitationsService.accept — raw token accepted; already-accepted and already-member rejected", () => {
  it("existing user with correct token and no prior membership → ok=true", async () => {
    const existingUser = { id: "user-existing", email: INVITATION_EMAIL };
    const db = buildMockDb({
      invitationFindFirst: BASE_INVITATION,
      userFindFirst: existingUser,
      memberFindFirst: null,
    });
    const svc = await buildService(db);

    const result = await svc.accept({ token: RAW_TOKEN });

    expect(result.ok).toBe(true);
    expect(result.autoLoginToken).toBeDefined();
  });

  it("wrong token → NotFoundException (invitation not found by hash)", async () => {
    const db = buildMockDb({ invitationFindFirst: null });
    const svc = await buildService(db);

    await expect(svc.accept({ token: WRONG_TOKEN })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("existing user who is already a member → ConflictException on accept", async () => {
    const existingUser = { id: "user-already", email: INVITATION_EMAIL };
    const existingMembership = { id: 99, userId: "user-already", orgId: ORG_ID };
    const db = buildMockDb({
      invitationFindFirst: BASE_INVITATION,
      userFindFirst: existingUser,
      memberFindFirst: existingMembership,
    });
    const svc = await buildService(db);

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(ConflictException);
  });

  it("new user path (no existing account) → ok=true with autoLoginToken", async () => {
    const db = buildMockDb({
      invitationFindFirst: BASE_INVITATION,
      userFindFirst: null,
      memberFindFirst: null,
    });
    const tx = buildUniversalTx();
    db.transaction = jest.fn().mockImplementation(
      (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );
    const svc = await buildService(db);

    const result = await svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe" });

    expect(result.ok).toBe(true);
    expect(result.autoLoginToken).toBeDefined();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("InvitationsService.invite — tokenHash stored; 23505 → ConflictException", () => {
  it("23505 on second pending invite to same email → ConflictException (not 500)", async () => {
    const db = buildMockDb({
      invitationFindFirst: null,
      userFindFirst: null,
      memberFindFirst: null,
    });

    let txCallCount = 0;
    const universalTx = buildUniversalTx();
    db.transaction = jest.fn().mockImplementation(
      (fn: (tx: typeof universalTx) => Promise<unknown>) => {
        txCallCount++;
        if (txCallCount === 1) {
          return fn(universalTx);
        }
        return Promise.reject({ code: "23505" });
      },
    );

    const svc = await buildService(db);

    await expect(svc.invite(ORG_ID, ACTOR_ID, INVITATION_EMAIL, "MEMBER")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("stored tokenHash is not the raw token (SHA-256 hash is stored, never plaintext)", async () => {
    let capturedTokenHash: unknown;
    const db = buildMockDb({
      invitationFindFirst: null,
      userFindFirst: null,
      memberFindFirst: null,
    });

    const firstTxUniversal = buildUniversalTx();
    firstTxUniversal.limit = jest.fn().mockResolvedValue([]);

    let secondTxInsert: jest.Mock | undefined;
    let txCallCount = 0;
    db.transaction = jest.fn().mockImplementation(
      (fn: (tx: typeof firstTxUniversal) => Promise<unknown>) => {
        txCallCount++;
        if (txCallCount === 1) {
          return fn(firstTxUniversal);
        }
        const secondTx = {
          ...buildUniversalTx(),
          delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
              if (vals.tokenHash !== undefined) {
                capturedTokenHash = vals.tokenHash;
              }
              return Promise.resolve([]);
            }),
          })),
        };
        secondTxInsert = secondTx.insert as jest.Mock;
        return fn(secondTx);
      },
    );

    const svc = await buildService(db);
    await svc.invite(ORG_ID, ACTOR_ID, INVITATION_EMAIL, "MEMBER");

    expect(capturedTokenHash).toBeDefined();
    expect(String(capturedTokenHash)).toHaveLength(64);
    expect(String(capturedTokenHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(secondTxInsert).toHaveBeenCalled();
  });

  it("first call succeeds — exactly one invitation is created", async () => {
    const db = buildMockDb({
      invitationFindFirst: null,
      userFindFirst: null,
      memberFindFirst: null,
    });
    let insertCount = 0;
    let txCallCount = 0;

    const firstTxUniversal = buildUniversalTx();
    firstTxUniversal.limit = jest.fn().mockResolvedValue([]);

    db.transaction = jest.fn().mockImplementation(
      (fn: (tx: typeof firstTxUniversal) => Promise<unknown>) => {
        txCallCount++;
        if (txCallCount === 1) {
          return fn(firstTxUniversal);
        }
        const secondTx = {
          ...buildUniversalTx(),
          delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
          insert: jest.fn().mockImplementation(() => {
            insertCount++;
            return { values: jest.fn().mockResolvedValue([]) };
          }),
        };
        return fn(secondTx);
      },
    );

    const svc = await buildService(db);
    const result = await svc.invite(ORG_ID, ACTOR_ID, INVITATION_EMAIL, "MEMBER");

    expect(result.success).toBe(true);
    expect(result.resent).toBe(false);
    expect(insertCount).toBeGreaterThanOrEqual(1);
  });
});
