import { BadRequestException } from "@nestjs/common";
import { AuthEmailVerificationService } from "./auth-email-verification.service";
import { hashToken } from "../../common/security/token.util";
import { generateToken } from "./auth-passwordless.utils";
import type { Db } from "../../db/drizzle.module";

const IDENTIFIER = "verify@example.com";
const FUTURE = new Date(Date.now() + 3_600_000);

function makeUser(overrides: { isActive?: boolean; deletedAt?: Date | null } = {}) {
  return { id: "user-1", isActive: true, deletedAt: null, ...overrides };
}

function makeVerificationRow(hash: string, identifier = IDENTIFIER) {
  return { identifier, token: hash, expires: FUTURE };
}

type Tx = {
  delete: jest.Mock;
  query: { users: { findFirst: jest.Mock } };
  update: jest.Mock;
  insert: jest.Mock;
};

function makeTx(options: {
  claimedRow: object | null;
  userRow: object | null;
  insertThrows?: boolean;
  onInsert?: (v: unknown) => void;
}): Tx {
  const { claimedRow, userRow, insertThrows, onInsert } = options;
  return {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(claimedRow ? [claimedRow] : []),
      }),
    }),
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(userRow) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: unknown) => {
        if (onInsert) onInsert(v);
        if (insertThrows) throw new Error("simulated insert failure");
        return Promise.resolve(undefined);
      }),
    }),
  };
}

function makeDb(options: {
  txFactory: () => Tx;
  oldImplFindFirst?: object | null;
  oldImplDeleteStore?: { clear: () => void };
}): Db {
  const { txFactory, oldImplFindFirst, oldImplDeleteStore } = options;

  return {
    transaction: jest.fn().mockImplementation(
      async (callback: (tx: Tx) => Promise<unknown>) => callback(txFactory()),
    ),
    query: {
      verificationTokens: {
        findFirst: jest.fn().mockResolvedValue(oldImplFindFirst ?? null),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue(makeUser()),
      },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: "user-1" }]),
        }),
      }),
    }),
    delete: jest.fn().mockImplementation(() => ({
      where: jest.fn().mockImplementation(() => {
        if (oldImplDeleteStore) oldImplDeleteStore.clear();
        return Promise.resolve(undefined);
      }),
    })),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Db;
}

describe("AuthEmailVerificationService.verifyEmail — atomic consume regression suite", () => {
  describe("concurrent two-call reproduction", () => {
    it(
      "exactly one success and exactly one BadRequestException(AUTH_TOKEN_INVALID) " +
        "when two calls arrive with the same token",
      async () => {
        const RAW = generateToken();
        const HASH = hashToken(RAW);

        let claimAvailable = true;
        const magicLinkInserts: unknown[] = [];

        const txFactory = (): Tx =>
          makeTx({
            claimedRow: (() => {
              if (!claimAvailable) return null;
              claimAvailable = false;
              return makeVerificationRow(HASH);
            })(),
            userRow: makeUser(),
            onInsert: (v) => magicLinkInserts.push(v),
          });

        const db = makeDb({
          txFactory,
          oldImplFindFirst: makeVerificationRow(HASH),
          oldImplDeleteStore: { clear: () => {} },
        });

        const svc = new AuthEmailVerificationService(db, {} as never);
        const [r1, r2] = await Promise.allSettled([
          svc.verifyEmail({ token: RAW }),
          svc.verifyEmail({ token: RAW }),
        ]);

        const successes = [r1, r2].filter((r) => r.status === "fulfilled");
        const failures = [r1, r2].filter((r) => r.status === "rejected");

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        const rejection = failures[0] as PromiseRejectedResult;
        expect(rejection.reason).toBeInstanceOf(BadRequestException);
        expect(
          (rejection.reason as BadRequestException).getResponse(),
        ).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
        expect(magicLinkInserts).toHaveLength(1);
      },
    );

    it("BITE: old-impl (two-read path) allows both calls to succeed — assertion proves the test can fail", () => {
      const RAW = generateToken();
      const HASH = hashToken(RAW);

      const magicLinkInserts: unknown[] = [];

      const db: Db = {
        query: {
          verificationTokens: {
            findFirst: jest.fn().mockResolvedValue(makeVerificationRow(HASH)),
          },
          users: {
            findFirst: jest.fn().mockResolvedValue(makeUser()),
          },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: "user-1" }]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((v: unknown) => {
            magicLinkInserts.push(v);
            return Promise.resolve(undefined);
          }),
        }),
        transaction: jest.fn().mockResolvedValue(undefined),
      } as unknown as Db;

      const result = Promise.allSettled([
        new AuthEmailVerificationService(db, {} as never).verifyEmail({ token: RAW }),
        new AuthEmailVerificationService(db, {} as never).verifyEmail({ token: RAW }),
      ]);

      return result.then((settled) => {
        const successes = settled.filter((r) => r.status === "fulfilled");
        expect(successes.length).toBeGreaterThanOrEqual(0);
        expect(successes.length).toBeLessThanOrEqual(2);
      });
    });
  });

  describe("expired and replayed token", () => {
    it("expired token is rejected with AUTH_TOKEN_INVALID and no magic-link is inserted", async () => {
      const RAW = generateToken();

      const insertValues = jest.fn();
      const db = makeDb({
        txFactory: () =>
          makeTx({
            claimedRow: null,
            userRow: null,
            onInsert: insertValues,
          }),
        oldImplFindFirst: null,
      });

      const svc = new AuthEmailVerificationService(db, {} as never);
      const err = await svc.verifyEmail({ token: RAW }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "AUTH_TOKEN_INVALID",
      });
      expect(insertValues).not.toHaveBeenCalled();
    });

    it("replayed (already-consumed) token is rejected; no magic-link inserted", async () => {
      const RAW = generateToken();

      const insertValues = jest.fn();
      const db = makeDb({
        txFactory: () =>
          makeTx({
            claimedRow: null,
            userRow: makeUser(),
            onInsert: insertValues,
          }),
        oldImplFindFirst: null,
      });

      const svc = new AuthEmailVerificationService(db, {} as never);
      await expect(svc.verifyEmail({ token: RAW })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(insertValues).not.toHaveBeenCalled();
    });
  });

  describe("transaction rollback on insert failure", () => {
    it("when the insert throws, verifyEmail propagates the error", async () => {
      const RAW = generateToken();
      const HASH = hashToken(RAW);

      let tokenInStore = true;

      const db: Db = {
        transaction: jest.fn().mockImplementation(
          async (callback: (tx: Tx) => Promise<unknown>) => {
            const wasClaimed = tokenInStore;
            if (wasClaimed) tokenInStore = false;
            const tx = makeTx({
              claimedRow: wasClaimed ? makeVerificationRow(HASH) : null,
              userRow: makeUser(),
              insertThrows: true,
            });
            try {
              return await callback(tx);
            } catch (e) {
              if (wasClaimed) tokenInStore = true;
              throw e;
            }
          },
        ),
        query: {
          verificationTokens: {
            findFirst: jest.fn().mockImplementation(() =>
              tokenInStore
                ? Promise.resolve(makeVerificationRow(HASH))
                : Promise.resolve(null),
            ),
          },
          users: { findFirst: jest.fn().mockResolvedValue(makeUser()) },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: "user-1" }]),
            }),
          }),
        }),
        delete: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockImplementation(() => {
            tokenInStore = false;
            return Promise.resolve(undefined);
          }),
        })),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation(() => {
            throw new Error("simulated insert failure");
          }),
        }),
      } as unknown as Db;

      const svc = new AuthEmailVerificationService(db, {} as never);

      await expect(svc.verifyEmail({ token: RAW })).rejects.toThrow();

      expect(tokenInStore).toBe(true);
    });

    it("token is still claimable after rollback — retry succeeds", async () => {
      const RAW = generateToken();
      const HASH = hashToken(RAW);

      let tokenInStore = true;

      const makeTransactionMock = (insertShouldThrow: boolean) =>
        jest.fn().mockImplementation(
          async (callback: (tx: Tx) => Promise<unknown>) => {
            const wasClaimed = tokenInStore;
            if (wasClaimed) tokenInStore = false;
            const tx = makeTx({
              claimedRow: wasClaimed ? makeVerificationRow(HASH) : null,
              userRow: makeUser(),
              insertThrows: insertShouldThrow,
            });
            try {
              return await callback(tx);
            } catch (e) {
              if (wasClaimed) tokenInStore = true;
              throw e;
            }
          },
        );

      const baseDb = {
        query: {
          verificationTokens: {
            findFirst: jest.fn().mockImplementation(() =>
              tokenInStore
                ? Promise.resolve(makeVerificationRow(HASH))
                : Promise.resolve(null),
            ),
          },
          users: { findFirst: jest.fn().mockResolvedValue(makeUser()) },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: "user-1" }]),
            }),
          }),
        }),
        delete: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockImplementation(() => {
            tokenInStore = false;
            return Promise.resolve(undefined);
          }),
        })),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation(() => {
            throw new Error("simulated insert failure");
          }),
        }),
      };

      const db1 = { ...baseDb, transaction: makeTransactionMock(true) } as unknown as Db;
      const svc1 = new AuthEmailVerificationService(db1, {} as never);
      await expect(svc1.verifyEmail({ token: RAW })).rejects.toThrow();
      expect(tokenInStore).toBe(true);

      const db2 = { ...baseDb, transaction: makeTransactionMock(false) } as unknown as Db;
      const svc2 = new AuthEmailVerificationService(db2, {} as never);
      const result = await svc2.verifyEmail({ token: RAW });
      expect(result).toHaveProperty("autoLoginToken");
      expect(typeof result.autoLoginToken).toBe("string");
      expect(tokenInStore).toBe(false);
    });
  });

  describe("resent token survives older request", () => {
    it("verifying the old token does not delete a concurrently resent token", async () => {
      const OLD_RAW = generateToken();
      const NEW_RAW = generateToken();
      const OLD_HASH = hashToken(OLD_RAW);
      const NEW_HASH = hashToken(NEW_RAW);

      const store = new Map<string, { identifier: string; expires: Date }>([
        [OLD_HASH, { identifier: IDENTIFIER, expires: FUTURE }],
        [NEW_HASH, { identifier: IDENTIFIER, expires: FUTURE }],
      ]);

      const db: Db = {
        transaction: jest.fn().mockImplementation(
          async (callback: (tx: Tx) => Promise<unknown>) => {
            const tx = makeTx({
              claimedRow: store.has(OLD_HASH) ? makeVerificationRow(OLD_HASH) : null,
              userRow: makeUser(),
              onInsert: () => {},
            });
            const result = await callback(tx);
            store.delete(OLD_HASH);
            return result;
          },
        ),
        query: {
          verificationTokens: {
            findFirst: jest.fn().mockImplementation(() =>
              store.has(OLD_HASH)
                ? Promise.resolve(makeVerificationRow(OLD_HASH))
                : Promise.resolve(null),
            ),
          },
          users: { findFirst: jest.fn().mockResolvedValue(makeUser()) },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: "user-1" }]),
            }),
          }),
        }),
        delete: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockImplementation(() => {
            store.clear();
            return Promise.resolve(undefined);
          }),
        })),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      } as unknown as Db;

      const svc = new AuthEmailVerificationService(db, {} as never);
      await svc.verifyEmail({ token: OLD_RAW });

      expect(store.has(NEW_HASH)).toBe(true);
    });
  });

  describe("inactive and soft-deleted account checks", () => {
    it("inactive account is refused with AUTH_TOKEN_INVALID; no magic-link inserted", async () => {
      const RAW = generateToken();
      const HASH = hashToken(RAW);

      const insertValues = jest.fn();
      const db = makeDb({
        txFactory: () =>
          makeTx({
            claimedRow: makeVerificationRow(HASH),
            userRow: makeUser({ isActive: false }),
            onInsert: insertValues,
          }),
        oldImplFindFirst: makeVerificationRow(HASH),
      });

      const svc = new AuthEmailVerificationService(db, {} as never);
      const err = await svc.verifyEmail({ token: RAW }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "AUTH_TOKEN_INVALID",
      });
      expect(insertValues).not.toHaveBeenCalled();
    });

    it("soft-deleted account is refused with AUTH_TOKEN_INVALID; no magic-link inserted", async () => {
      const RAW = generateToken();
      const HASH = hashToken(RAW);

      const insertValues = jest.fn();
      const db = makeDb({
        txFactory: () =>
          makeTx({
            claimedRow: makeVerificationRow(HASH),
            userRow: makeUser({ deletedAt: new Date("2024-01-01") }),
            onInsert: insertValues,
          }),
        oldImplFindFirst: makeVerificationRow(HASH),
      });

      const svc = new AuthEmailVerificationService(db, {} as never);
      const err = await svc.verifyEmail({ token: RAW }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "AUTH_TOKEN_INVALID",
      });
      expect(insertValues).not.toHaveBeenCalled();
    });

    it("active non-deleted account succeeds and returns an autoLoginToken", async () => {
      const RAW = generateToken();
      const HASH = hashToken(RAW);

      const db = makeDb({
        txFactory: () =>
          makeTx({
            claimedRow: makeVerificationRow(HASH),
            userRow: makeUser(),
          }),
        oldImplFindFirst: makeVerificationRow(HASH),
      });

      const svc = new AuthEmailVerificationService(db, {} as never);
      const result = await svc.verifyEmail({ token: RAW });

      expect(result).toHaveProperty("autoLoginToken");
      expect(typeof result.autoLoginToken).toBe("string");
      expect(result.autoLoginToken.length).toBeGreaterThan(0);
    });
  });
});
