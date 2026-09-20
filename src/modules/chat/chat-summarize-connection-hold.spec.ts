import { getTenantContext } from "../../common/tenant/tenant-context";
import { NO_TENANT_TRANSACTION } from "../../common/tenant/no-tenant-transaction.decorator";
import { primeRelocationTrafficTracker } from "../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../db/drizzle.module";
import { ChatSummarizeController } from "./chat-summarize.controller";
import { ChatSummarizeService } from "./chat-summarize.service";

const ACTOR = { orgId: "org-1", userId: "user-1" };
const CHANNEL_ID = 42;

interface Trace {
  transactionDepth: number;
  transactions: number;
  dbDepths: number[];
  providerDepth: number | undefined;
}

function tracingDb(trace: Trace): Db {
  const recordDbTouch = <T>(value: T): Promise<T> => {
    trace.dbDepths.push(trace.transactionDepth);
    return Promise.resolve(value);
  };

  const chain = {
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () =>
      recordDbTouch([
        {
          id: 1,
          content: "ship it",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          senderName: "Alice",
          senderEmail: "alice@example.com",
        },
      ]),
  };

  const db = {
    query: {
      organizationMembers: {
        findFirst: () => recordDbTouch({ id: 1, isOwner: false }),
      },
      chatChannels: {
        findFirst: () =>
          recordDbTouch({ id: CHANNEL_ID, isPrivate: false, entityType: null, entityId: null }),
      },
      chatChannelMembers: {
        findFirst: () => recordDbTouch({ role: "MEMBER" }),
      },
    },
    select: () => ({ from: () => chain }),
    execute: async () => [],
    transaction: async <T>(run: (tx: Db) => Promise<T>): Promise<T> => {
      trace.transactions += 1;
      trace.transactionDepth += 1;
      try {
        return await run(db as unknown as Db);
      } finally {
        trace.transactionDepth -= 1;
      }
    },
  };

  return db as unknown as Db;
}

function serviceThatRecordsDepth(trace: Trace): ChatSummarizeService {
  const db = tracingDb(trace);
  const moduleRef = {
    get: () => ({
      invokeText: async () => {
        trace.providerDepth = getTenantContext() ? 1 : 0;
        return {
          ok: true as const,
          data: "Summary",
          model: "fast",
          latencyMs: 1,
          correlationId: "correlation-1",
          usage: {},
        };
      },
    }),
  };
  const entities = { resolve: async () => [] };

  return new ChatSummarizeService(db, moduleRef as never, entities as never);
}

describe("chat summarize connection hold", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("opts the handler out of the request-wide tenant transaction", () => {
    const metadata = Reflect.getMetadata(
      NO_TENANT_TRANSACTION,
      ChatSummarizeController.prototype.summarize,
    );

    expect(metadata).toBe(true);
  });

  it("keeps every database touch in one short transaction and invokes the provider at depth zero", async () => {
    const trace: Trace = {
      transactionDepth: 0,
      transactions: 0,
      dbDepths: [],
      providerDepth: undefined,
    };

    await serviceThatRecordsDepth(trace).summarize(CHANNEL_ID, ACTOR);

    expect(trace.dbDepths.length).toBeGreaterThan(0);
    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepth).toBe(0);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });
});
