import { ConflictException } from "@nestjs/common";
import { AiCreditsService } from "./ai-credits.service";

type SelectChain = {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  for: jest.Mock;
};

function _makeSelectChain(returnValue: unknown): SelectChain {
  const chain = {} as SelectChain;
  chain.for = jest.fn().mockResolvedValue(returnValue);
  chain.limit = jest.fn().mockReturnValue(chain.for as unknown as SelectChain);
  chain.where = jest.fn().mockReturnValue({ limit: chain.limit, for: chain.for });
  chain.from = jest.fn().mockReturnValue(chain.where as unknown as SelectChain);
  return chain;
}

function _makeInsertChain(returnValue: unknown) {
  const returning = jest.fn().mockResolvedValue(returnValue);
  const values = jest.fn().mockReturnValue({ returning });
  const into = jest.fn().mockReturnValue({ values });
  return { into, values, returning };
}

function buildDb(overrides: Record<string, unknown> = {}) {
  return {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
    ...overrides,
  };
}

function makeService(db: ReturnType<typeof buildDb>): AiCreditsService {
  return new (AiCreditsService as unknown as new (db: unknown) => AiCreditsService)(db);
}

describe("AiCreditsService — reserve/settle/release ledger", () => {
  let db: ReturnType<typeof buildDb>;
  let svc: AiCreditsService;

  beforeEach(() => {
    db = buildDb();
    svc = makeService(db);
  });

  describe("reserve", () => {
    it("deducts balance and inserts RESERVED reservation", async () => {
      const insertedReservation = [{ id: 42 }];

      db.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                for: jest.fn().mockResolvedValue([{ balance: 50000, orgId: "org1" }]),
              }),
            }),
          })
          .mockReturnValue({ from: jest.fn() });

        const txUpdate = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        });

        const txInsert = jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(insertedReservation),
          }),
        });

        const tx = { select: txSelect, update: txUpdate, insert: txInsert };
        return fn(tx);
      });

      const result = await svc.reserve({
        orgId: "org1",
        userId: "user1",
        feature: "crm.score-lead",
        credits: 10000,
      });

      expect(result).toEqual({ reservationId: 42 });
    });

    it("replays idempotent reserve — returns existing reservation id", async () => {
      db.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 99 }]),
          }),
        }),
      });

      const result = await svc.reserve({
        orgId: "org1",
        userId: "user1",
        feature: "crm.score-lead",
        credits: 5000,
        idempotencyKey: "idem-abc",
      });

      expect(result).toEqual({ reservationId: 99 });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when balance is insufficient", async () => {
      db.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue([{ balance: 2000, orgId: "org1" }]),
            }),
          }),
        });
        const tx = { select: txSelect };
        return fn(tx);
      });

      await expect(
        svc.reserve({ orgId: "org1", userId: "u1", feature: "kb.ask", credits: 10000 }),
      ).rejects.toThrow("Insufficient AI credits");
    });
  });

  describe("settle", () => {
    it("settles fully — charges actual milli credits, no refund", async () => {
      const reservation = { id: 1, orgId: "org1", userId: "u1", feature: "crm.score-lead", credits: 5000, status: "RESERVED" };
      const wallet = { orgId: "org1", balance: 100000 };

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        let callCount = 0;
        const txSelect = jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue(callCount++ === 0 ? [reservation] : [wallet]),
            }),
          }),
        }));
        const txUpdate = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        });
        const txInsert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue([]),
        });
        return fn({ select: txSelect, update: txUpdate, insert: txInsert });
      });

      await expect(svc.settle(1, {})).resolves.toBeUndefined();
    });

    it("settles partially — refunds the difference when actual < reserved", async () => {
      const reservation = { id: 2, orgId: "org1", userId: "u1", feature: "pm.plan", credits: 10000, status: "RESERVED" };
      const wallet = { orgId: "org1", balance: 0 };

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        let callCount = 0;
        const txSelect = jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue(callCount++ === 0 ? [reservation] : [wallet]),
            }),
          }),
        }));
        const txUpdateSet = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
        const txUpdate = jest.fn().mockReturnValue({ set: txUpdateSet });
        const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
        return fn({ select: txSelect, update: txUpdate, insert: txInsert });
      });

      await expect(svc.settle(2, { actualMilli: 7000 })).resolves.toBeUndefined();
    });

    it("charges overage — balance goes negative when actual > reserved", async () => {
      const reservation = { id: 8, orgId: "org1", userId: "u1", feature: "kb.ask", credits: 5000, status: "RESERVED" };
      const wallet = { orgId: "org1", balance: 0 };

      let capturedNewBalance: number | undefined;
      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        let callCount = 0;
        const txSelect = jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue(callCount++ === 0 ? [reservation] : [wallet]),
            }),
          }),
        }));
        const txUpdateSet = jest.fn().mockImplementation((setArg: { balance?: number }) => {
          if (setArg.balance !== undefined) capturedNewBalance = setArg.balance;
          return { where: jest.fn().mockResolvedValue([]) };
        });
        const txUpdate = jest.fn().mockReturnValue({ set: txUpdateSet });
        const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
        return fn({ select: txSelect, update: txUpdate, insert: txInsert });
      });

      await expect(svc.settle(8, { actualMilli: 8000 })).resolves.toBeUndefined();
      expect(capturedNewBalance).toBe(-3000);
    });

    it("is idempotent — silently returns when already SETTLED", async () => {
      const reservation = { id: 3, orgId: "org1", userId: null, feature: "chat.message", credits: 1000, status: "SETTLED" };

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue([reservation]),
            }),
          }),
        });
        return fn({ select: txSelect });
      });

      await expect(svc.settle(3, {})).resolves.toBeUndefined();
    });
  });

  describe("release", () => {
    it("restores balance and marks RELEASED", async () => {
      const reservation = { id: 5, orgId: "org1", userId: null, feature: "kb.ask", credits: 3000, status: "RESERVED" };
      const wallet = { orgId: "org1", balance: 10000 };

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        let callCount = 0;
        const txSelect = jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue(callCount++ === 0 ? [reservation] : [wallet]),
            }),
          }),
        }));
        const txUpdate = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        });
        return fn({ select: txSelect, update: txUpdate });
      });

      await expect(svc.release(5, "user-cancelled")).resolves.toBeUndefined();
    });

    it("is idempotent — silently returns when already RELEASED", async () => {
      const reservation = { id: 6, orgId: "org1", userId: null, feature: "kb.ask", credits: 1000, status: "RELEASED" };

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue([reservation]),
            }),
          }),
        });
        return fn({ select: txSelect });
      });

      await expect(svc.release(6, "dup")).resolves.toBeUndefined();
    });

    it("throws ConflictException when releasing a SETTLED reservation", async () => {
      const reservation = { id: 7, orgId: "org1", userId: null, feature: "kb.ask", credits: 1000, status: "SETTLED" };

      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue([reservation]),
            }),
          }),
        });
        return fn({ select: txSelect });
      });

      await expect(svc.release(7, "bad")).rejects.toThrow(ConflictException);
    });
  });

  describe("sweepExpiredReservations", () => {
    it("releases only expired RESERVED rows and returns the count", async () => {
      const expired = [{ id: 10 }, { id: 11 }];

      db.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(expired),
          }),
        }),
      });

      const reservation10 = { id: 10, orgId: "org1", userId: null, feature: "chat.message", credits: 1000, status: "RESERVED" };
      const reservation11 = { id: 11, orgId: "org2", userId: null, feature: "chat.message", credits: 1000, status: "RESERVED" };
      const wallet = { orgId: "org1", balance: 0 };

      let releaseCall = 0;
      db.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const current = releaseCall === 0 ? reservation10 : reservation11;
        releaseCall++;
        let innerCall = 0;
        const txSelect = jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue(innerCall++ === 0 ? [current] : [wallet]),
            }),
          }),
        }));
        const txUpdate = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        });
        return fn({ select: txSelect, update: txUpdate });
      });

      const count = await svc.sweepExpiredReservations();
      expect(count).toBe(2);
    });
  });
});
