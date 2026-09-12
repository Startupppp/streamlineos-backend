jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { hashToken } from "../../../common/security/token.util";
import {
  accountOrganizationIndex,
  invitationEvents,
  invitations,
  magicLinkTokens,
  organizationAllowedEmailDomains,
  organizationMembers,
  users,
} from "../../../db/schema";
import { acceptInvitationSchema } from "./dto/organization.schemas";

const ORG_ID = "org-p11";
const OTHER_ORG_ID = "org-p11-second";
const RAW_TOKEN = "e".repeat(64);
const TOKEN_HASH = hashToken(RAW_TOKEN);
const INVITED_EMAIL = "new.joiner@acme.test";

const PENDING_INVITATION = {
  id: "inv-p11",
  email: INVITED_EMAIL,
  orgId: ORG_ID,
  role: "MEMBER",
  tokenHash: TOKEN_HASH,
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  status: "PENDING",
  inviterMembershipId: null,
};

const ACTIVE_ORG = {
  name: "Acme",
  slug: "acme",
  region: "primary",
  status: "ACTIVE",
  deletedAt: null,
};

const PROJECTED_MEMBERSHIP = {
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
};

type Row = Record<string, unknown>;

interface RecordedOperation {
  transaction: number;
  op: string;
  table: unknown;
}

/** A driver error shaped the way `getPostgresErrorDetails` reads one: the SQLSTATE,
 *  the relation and the constraint all sit on the same object, one `cause` down. */
function uniqueViolation(constraint: string, table: string): Error {
  const driverError = Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint_name: constraint,
    table_name: table,
  });
  return Object.assign(new Error("Failed query"), { cause: driverError });
}

function buildHarness() {
  const invitationFindFirst = jest.fn<Promise<Row | null>, [unknown?]>();
  const userFindFirst = jest.fn<Promise<Row | null>, [unknown?]>();
  const memberFindFirst = jest.fn<Promise<Row | null>, [unknown?]>();
  const orgFindFirst = jest.fn<Promise<Row | null>, [unknown?]>();

  invitationFindFirst.mockResolvedValue(PENDING_INVITATION);
  userFindFirst.mockResolvedValue(null);
  memberFindFirst.mockResolvedValue(PROJECTED_MEMBERSHIP);
  orgFindFirst.mockResolvedValue(ACTIVE_ORG);

  const lockedRows = { value: [PENDING_INVITATION] as Row[] };
  const domains = { value: [] as { domain: string }[] };
  const claimedRows = { value: [{ id: PENDING_INVITATION.id }] as Row[] };
  const membershipRows = { value: [{ id: 42 }] as Row[] };
  const insertFailures = new Map<unknown, unknown>();

  const operations: RecordedOperation[] = [];
  const updates: { table: unknown; values: Row }[] = [];
  let transactionCount = 0;
  let activeTransaction = 0;
  let selectedTable: unknown = null;

  function record(op: string, table: unknown): void {
    operations.push({ transaction: activeTransaction, op, table });
  }

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    query: {
      users: { findFirst: userFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
      organizations: { findFirst: orgFindFirst },
      invitations: { findFirst: invitationFindFirst },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockImplementation(function (this: unknown, table: unknown) {
      selectedTable = table;
      return this;
    }),
    where: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    orderBy: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    for: jest.fn().mockImplementation(function (this: unknown) {
      record("select-for-update", selectedTable);
      return this;
    }),
    limit: jest.fn().mockImplementation(() => {
      record("select", selectedTable);
      if (selectedTable === invitations) return Promise.resolve(lockedRows.value);
      if (selectedTable === organizationAllowedEmailDomains)
        return Promise.resolve(domains.value);
      return Promise.resolve([]);
    }),
    update: jest.fn().mockImplementation((table: unknown) => {
      record("update", table);
      const result = {
        returning: () =>
          Promise.resolve(table === invitations ? claimedRows.value : []),
        then: (resolve: (value: undefined) => unknown) =>
          Promise.resolve(undefined).then(resolve),
      };
      return {
        set: (values: Row) => {
          updates.push({ table, values });
          return { where: () => result };
        },
      };
    }),
    insert: jest.fn().mockImplementation((table: unknown) => {
      record("insert", table);
      const failure = insertFailures.get(table);
      const settle = <T>(value: T): Promise<T> =>
        failure === undefined ? Promise.resolve(value) : Promise.reject(failure);
      const chain = {
        returning: () =>
          settle(table === organizationMembers ? membershipRows.value : [{ id: 1 }]),
        onConflictDoNothing: () => chain,
        onConflictDoUpdate: () => chain,
        then: (
          resolve: (value: undefined) => unknown,
          reject: (reason: unknown) => unknown,
        ) => settle(undefined).then(resolve, reject),
      };
      return { values: () => chain };
    }),
  };

  const db = {
    query: tx.query,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (handle: typeof tx) => Promise<unknown>) => {
        transactionCount += 1;
        const previous = activeTransaction;
        activeTransaction = transactionCount;
        try {
          return await fn(tx);
        } finally {
          activeTransaction = previous;
        }
      }),
  };

  const cache = {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
  };

  const logged: string[] = [];
  const captureLog = (...args: unknown[]): void => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  };
  const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(captureLog);
  const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(captureLog);

  return {
    db,
    cache,
    tx,
    domains,
    lockedRows,
    claimedRows,
    membershipRows,
    invitationFindFirst,
    userFindFirst,
    memberFindFirst,
    orgFindFirst,
    failInsert: (table: unknown, error: unknown) => insertFailures.set(table, error),
    operations: () => operations,
    updatesFor: (table: unknown) =>
      updates.filter((entry) => entry.table === table).map((entry) => entry.values),
    tablesFor: (op: string) =>
      operations.filter((entry) => entry.op === op).map((entry) => entry.table),
    loggedMessages: () => logged,
    restore: () => {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

describe("InvitationAcceptanceService.accept — token acceptance recovery (P11)", () => {
  let svc: InvitationAcceptanceService;
  let harness: ReturnType<typeof buildHarness>;
  let planLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    harness = buildHarness();
    planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: harness.db },
        { provide: PlanLimitsService, useValue: planLimits },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CacheService, useValue: harness.cache },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    svc = moduleRef.get(InvitationAcceptanceService);
  });

  afterEach(() => {
    harness.restore();
    jest.restoreAllMocks();
  });

  function existingAccount(id = "user-existing"): void {
    harness.userFindFirst.mockResolvedValue({
      id,
      isActive: true,
      deletedAt: null,
    });
    harness.memberFindFirst.mockResolvedValueOnce(null);
  }

  describe("the transactional core", () => {
    it("locks the invitation, claims it and issues the magic link in one transaction", async () => {
      await svc.accept({ token: RAW_TOKEN, firstName: "Priya" });

      const lock = harness
        .operations()
        .find((op) => op.op === "select-for-update" && op.table === invitations);
      const claim = harness
        .operations()
        .find((op) => op.op === "update" && op.table === invitations);
      const magicLink = harness
        .operations()
        .find((op) => op.op === "insert" && op.table === magicLinkTokens);
      const member = harness
        .operations()
        .find((op) => op.op === "insert" && op.table === organizationMembers);

      expect(lock).toBeDefined();
      expect(claim?.transaction).toBe(lock?.transaction);
      expect(member?.transaction).toBe(lock?.transaction);
      expect(magicLink?.transaction).toBe(lock?.transaction);
    });

    it("returns a sign-in token only after the membership row was written", async () => {
      const result = await svc.accept({ token: RAW_TOKEN });

      expect(result.ok).toBe(true);
      expect(typeof result.autoLoginToken).toBe("string");
      expect(harness.tablesFor("insert")).toContain(organizationMembers);
      expect(harness.tablesFor("insert")).toContain(invitationEvents);
    });
  });

  describe("allowed-domain policy changed after issuance", () => {
    it("admits a new account while the invited domain is still permitted", async () => {
      harness.domains.value = [{ domain: "acme.test" }];

      await expect(svc.accept({ token: RAW_TOKEN })).resolves.toMatchObject({
        ok: true,
      });
    });

    it("matches the permitted domain regardless of case or padding", async () => {
      harness.domains.value = [{ domain: "  ACME.test " }];

      await expect(svc.accept({ token: RAW_TOKEN })).resolves.toMatchObject({
        ok: true,
      });
    });

    it("refuses an address the current allowed-domain list excludes", async () => {
      harness.domains.value = [{ domain: "corp.example" }];

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("creates no account, membership or sign-in token when the domain is refused", async () => {
      harness.domains.value = [{ domain: "corp.example" }];

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /Email domain not allowed/,
      );
      expect(harness.tablesFor("insert")).not.toContain(users);
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
      expect(harness.tablesFor("insert")).not.toContain(magicLinkTokens);
    });

    it("refuses an existing account on a now-excluded domain too", async () => {
      harness.domains.value = [{ domain: "corp.example" }];
      existingAccount();

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("screens the domain inside the transaction holding the invitation lock", async () => {
      harness.domains.value = [{ domain: "acme.test" }];

      await svc.accept({ token: RAW_TOKEN });

      const lock = harness
        .operations()
        .find((op) => op.op === "select-for-update" && op.table === invitations);
      const domainRead = harness
        .operations()
        .find((op) => op.table === organizationAllowedEmailDomains);
      expect(domainRead).toBeDefined();
      expect(domainRead?.transaction).toBe(lock?.transaction);
    });
  });

  describe("account and organization suspension", () => {
    it("refuses an account whose global profile is deactivated", async () => {
      harness.userFindFirst.mockResolvedValue({
        id: "user-suspended",
        isActive: false,
        deletedAt: null,
      });
      harness.memberFindFirst.mockResolvedValueOnce(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("does not reactivate the deactivated account it refused", async () => {
      harness.userFindFirst.mockResolvedValue({
        id: "user-suspended",
        isActive: false,
        deletedAt: null,
      });
      harness.memberFindFirst.mockResolvedValueOnce(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(/suspended/i);
      expect(harness.tablesFor("update")).not.toContain(users);
    });

    it("refuses an account whose global profile is soft-deleted", async () => {
      harness.userFindFirst.mockResolvedValue({
        id: "user-erased",
        isActive: true,
        deletedAt: new Date(),
      });
      harness.memberFindFirst.mockResolvedValueOnce(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("refuses acceptance into a suspended organization", async () => {
      harness.orgFindFirst.mockResolvedValue({ ...ACTIVE_ORG, status: "SUSPENDED" });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("refuses acceptance into a soft-deleted organization", async () => {
      harness.orgFindFirst.mockResolvedValue({
        ...ACTIVE_ORG,
        deletedAt: new Date(),
      });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("tokens that can no longer be accepted", () => {
    it("reports an expired, revoked or declined token as unusable", async () => {
      harness.invitationFindFirst.mockResolvedValue(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(harness.tablesFor("insert")).toHaveLength(0);
    });

    it("refuses a token revoked between the public read and the row lock", async () => {
      harness.lockedRows.value = [];

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("tells an active member they already belong", async () => {
      harness.userFindFirst.mockResolvedValue({
        id: "user-existing",
        isActive: true,
        deletedAt: null,
      });
      harness.memberFindFirst.mockResolvedValueOnce({ status: "ACTIVE" });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        "You are already a member of this organization",
      );
    });

    it("points a suspended membership at restore instead of re-admitting it", async () => {
      harness.userFindFirst.mockResolvedValue({
        id: "user-existing",
        isActive: true,
        deletedAt: null,
      });
      harness.memberFindFirst.mockResolvedValueOnce({ status: "SUSPENDED" });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /Ask an admin to restore you from Users/,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });
  });

  describe("exactly one of two parallel accepts wins", () => {
    it("gives the membership to the accept that took the row lock", async () => {
      let remaining = 1;
      harness.tx.limit.mockImplementation(() => {
        const fromCalls: unknown[][] = harness.tx.from.mock.calls;
        const table = fromCalls.at(-1)?.[0];
        if (table !== invitations) return Promise.resolve([]);
        if (remaining === 0) return Promise.resolve([]);
        remaining -= 1;
        return Promise.resolve([PENDING_INVITATION]);
      });

      const outcomes = await Promise.allSettled([
        svc.accept({ token: RAW_TOKEN }),
        svc.accept({ token: RAW_TOKEN }),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const loser = outcomes.find((o) => o.status === "rejected");
      expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(
        ConflictException,
      );
    });

    it("refuses the claim when another writer already flipped the row", async () => {
      harness.claimedRows.value = [];

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("a concurrent account creation for the same address", () => {
    it("resolves the raced account and completes the second invitation", async () => {
      harness.failInsert(users, uniqueViolation("users_email_unique", "users"));
      harness.invitationFindFirst
        .mockResolvedValueOnce(PENDING_INVITATION)
        .mockResolvedValue({ email: INVITED_EMAIL });
      harness.userFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: "user-raced", isActive: true, deletedAt: null });

      const result = await svc.accept({ token: RAW_TOKEN });

      expect(result.ok).toBe(true);
      expect(harness.tablesFor("insert")).toContain(organizationMembers);
      expect(harness.tablesFor("insert")).toContain(magicLinkTokens);
    });

    it("recovers from the case-insensitive email index as well", async () => {
      harness.failInsert(users, uniqueViolation("uniq_users_email_ci", "users"));
      harness.invitationFindFirst
        .mockResolvedValueOnce(PENDING_INVITATION)
        .mockResolvedValue({ email: INVITED_EMAIL });
      harness.userFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: "user-raced", isActive: true, deletedAt: null });

      await expect(svc.accept({ token: RAW_TOKEN })).resolves.toMatchObject({
        ok: true,
      });
    });

    it("asks the invitee to retry when the raced account rolled back", async () => {
      harness.failInsert(users, uniqueViolation("users_email_unique", "users"));
      harness.invitationFindFirst
        .mockResolvedValueOnce(PENDING_INVITATION)
        .mockResolvedValue({ email: INVITED_EMAIL });
      harness.userFindFirst.mockResolvedValue(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /Please open the invitation link again/,
      );
    });

    it("does not report an unrelated unique violation as an accepted invitation", async () => {
      harness.failInsert(
        magicLinkTokens,
        uniqueViolation("magic_link_tokens_pkey", "magic_link_tokens"),
      );

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.not.toThrow(
        /already been accepted/,
      );
    });
  });

  describe("two organizations inviting the same new address", () => {
    it("leaves the second invitation acceptable once the account exists", async () => {
      await expect(svc.accept({ token: RAW_TOKEN })).resolves.toMatchObject({
        ok: true,
      });

      const secondInvitation = {
        ...PENDING_INVITATION,
        id: "inv-p11-second",
        orgId: OTHER_ORG_ID,
      };
      harness.invitationFindFirst.mockResolvedValue(secondInvitation);
      harness.lockedRows.value = [secondInvitation];
      existingAccount("user-from-first-accept");

      await expect(svc.accept({ token: RAW_TOKEN })).resolves.toMatchObject({
        ok: true,
      });
      expect(harness.cache.invalidateForOrg).toHaveBeenCalledWith(
        OTHER_ORG_ID,
        "users:stats",
      );
    });
  });

  describe("the organization-index projection", () => {
    it("keeps the membership when the projection write fails", async () => {
      harness.failInsert(accountOrganizationIndex, new Error("projection refused"));

      const result = await svc.accept({ token: RAW_TOKEN });

      expect(result.ok).toBe(true);
      expect(typeof result.autoLoginToken).toBe("string");
      expect(harness.tablesFor("insert")).toContain(organizationMembers);
      expect(harness.tablesFor("insert")).toContain(magicLinkTokens);
    });

    it("still invalidates the session and membership caches after a failed projection", async () => {
      harness.failInsert(accountOrganizationIndex, new Error("projection refused"));

      await svc.accept({ token: RAW_TOKEN });

      expect(harness.cache.invalidate).toHaveBeenCalled();
      expect(harness.cache.invalidateForOrg).toHaveBeenCalledWith(
        ORG_ID,
        "users:stats",
      );
    });

    it("reports a thrown projection instead of swallowing it", async () => {
      harness.failInsert(accountOrganizationIndex, new Error("projection refused"));

      await svc.accept({ token: RAW_TOKEN });

      expect(
        harness
          .loggedMessages()
          .some(
            (message) =>
              message.includes("account-organization-index projection failed") &&
              message.includes("projection refused"),
          ),
      ).toBe(true);
    });

    it("reports a projection that silently wrote nothing", async () => {
      harness.memberFindFirst.mockResolvedValue(null);

      await svc.accept({ token: RAW_TOKEN });

      expect(harness.tablesFor("insert")).not.toContain(accountOrganizationIndex);
      expect(
        harness
          .loggedMessages()
          .some((message) =>
            message.includes("account-organization-index projection failed"),
          ),
      ).toBe(true);
    });
  });


  describe("P10/P11 — the six cross-lane entry cases", () => {
    function boundValues(value: unknown, seen = new Set<object>()): unknown[] {
      if (
        value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        return [value];
      if (value instanceof Date) return [value.toISOString()];
      if (Array.isArray(value)) return value.flatMap((item) => boundValues(item, seen));
      if (typeof value !== "object" || seen.has(value)) return [];
      seen.add(value);
      const record = value as Record<string, unknown>;
      return [
        ...(Array.isArray(record["queryChunks"])
          ? boundValues(record["queryChunks"], seen)
          : []),
        ...("value" in record ? boundValues(record["value"], seen) : []),
      ];
    }

    it("selects the invitation only while it is PENDING, unaccepted and unexpired", async () => {
      await svc.accept({ token: RAW_TOKEN });

      const bound = boundValues(
        (harness.invitationFindFirst.mock.calls[0]?.[0] as Row | undefined)?.["where"],
      );
      expect(bound).toContain(TOKEN_HASH);
      expect(bound).toContain("PENDING");
      expect(bound.some((entry) => typeof entry === "string" && entry.includes("T"))).toBe(
        true,
      );
    });

    it("refuses an expired token without disclosing that the invitation exists", async () => {
      harness.invitationFindFirst.mockResolvedValue(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        "Invalid or expired invitation",
      );
      expect(harness.tablesFor("insert")).toEqual([]);
    });

    it("refuses a revoked token with the same non-disclosing answer", async () => {
      harness.invitationFindFirst.mockResolvedValue(null);

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        "Invalid or expired invitation",
      );
    });

    it("refuses a token revoked between the public read and the lock", async () => {
      harness.lockedRows.value = [];

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /already been accepted/,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("binds the account to the invited address, never to a signed-in caller", async () => {
      expect(acceptInvitationSchema.safeParse({ token: RAW_TOKEN }).success).toBe(true);
      expect(
        acceptInvitationSchema.safeParse({
          token: RAW_TOKEN,
          email: "someone.else@acme.test",
        }).success,
      ).toBe(false);

      await svc.accept({ token: RAW_TOKEN });

      const bound = boundValues(
        (harness.userFindFirst.mock.calls[0]?.[0] as Row | undefined)?.["where"],
      );
      expect(bound).toContain(INVITED_EMAIL);
    });

    it("admits an account that already belongs to another organization", async () => {
      existingAccount("user-in-other-org");

      await expect(svc.accept({ token: RAW_TOKEN })).resolves.toMatchObject({ ok: true });
      expect(harness.tablesFor("insert")).toContain(organizationMembers);
    });

    it("never rewrites the global identity of that account", async () => {
      existingAccount("user-in-other-org");

      await svc.accept({ token: RAW_TOKEN });

      const userWrites = harness.updatesFor(users);
      expect(harness.tablesFor("insert")).not.toContain(users);
      expect(userWrites).toHaveLength(1);
      expect(Object.keys(userWrites[0] ?? {})).toEqual(["lastActiveOrgId"]);
      expect(userWrites[0]).toEqual({ lastActiveOrgId: ORG_ID });
    });

    it("refuses a globally suspended account and reactivates nothing", async () => {
      harness.userFindFirst.mockResolvedValue({
        id: "user-suspended",
        isActive: false,
        deletedAt: null,
      });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /account is suspended/,
      );
      expect(harness.updatesFor(users)).toEqual([]);
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("refuses a suspended account discovered on the concurrent-signup recovery path", async () => {
      harness.failInsert(users, uniqueViolation("users_email_unique", "users"));
      harness.invitationFindFirst
        .mockResolvedValueOnce(PENDING_INVITATION)
        .mockResolvedValue({ email: INVITED_EMAIL });
      harness.userFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: "user-raced", isActive: false, deletedAt: null });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /account is suspended/,
      );
      expect(harness.tablesFor("insert")).not.toContain(organizationMembers);
    });

    it("refuses a soft-deleted account discovered on that same recovery path", async () => {
      harness.failInsert(users, uniqueViolation("uniq_users_email_ci", "users"));
      harness.invitationFindFirst
        .mockResolvedValueOnce(PENDING_INVITATION)
        .mockResolvedValue({ email: INVITED_EMAIL });
      harness.userFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: "user-raced", isActive: true, deletedAt: new Date() });

      await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
        /account is suspended/,
      );
    });
  });

  it("never writes the invitation token or the sign-in token into a log line", async () => {
    harness.failInsert(accountOrganizationIndex, new Error("projection refused"));

    const result = await svc.accept({ token: RAW_TOKEN });
    const logged = harness.loggedMessages().join("\n");

    expect(harness.loggedMessages().length).toBeGreaterThan(0);
    expect(logged).not.toContain(RAW_TOKEN);
    expect(logged).not.toContain(TOKEN_HASH);
    expect(logged).not.toContain(result.autoLoginToken);
  });
});
