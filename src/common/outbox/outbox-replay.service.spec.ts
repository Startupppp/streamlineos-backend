import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  OutboxReplayService,
  OUTBOX_REPLAY_BATCH,
  replayOrgDeadLetters,
} from "./outbox-replay.service";
import { forEachOrg } from "../tenant";
import type { TenantTx } from "../tenant";
import type { Db } from "../../db/drizzle.module";

jest.mock("../tenant", () => ({ forEachOrg: jest.fn() }));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const dialect = new PgDialect();

const ORG = "org-replay-1";

function makeTx(replayed: Array<{ id: number }> = []) {
  const captured: SQL[] = [];
  const capturedSet: Array<Record<string, unknown>> = [];
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedSet.push(values);
        return {
          where: jest.fn().mockImplementation((cond: SQL) => {
            captured.push(cond);
            return { returning: jest.fn().mockResolvedValue(replayed) };
          }),
        };
      }),
    }),
  };
  return { tx: tx as unknown as TenantTx, captured, capturedSet };
}

describe("replayOrgDeadLetters", () => {
  it("requeues a DEAD row as PENDING with its retry budget restored", async () => {
    const { tx, capturedSet } = makeTx([]);
    await replayOrgDeadLetters(tx, ORG);

    expect(capturedSet[0]).toEqual({
      deliveryState: "PENDING",
      retryCount: 0,
      leaseExpiresAt: null,
      deadLetteredAt: null,
    });
  });

  it("keeps last_error — the operator needs to know why it died before replaying it", async () => {
    const { tx, capturedSet } = makeTx([]);
    await replayOrgDeadLetters(tx, ORG);

    expect(capturedSet[0]).not.toHaveProperty("lastError");
  });

  it("selects only DEAD rows for this tenant, bounded by the replay batch", async () => {
    const { tx, captured } = makeTx([]);
    await replayOrgDeadLetters(tx, ORG);

    const rendered = dialect.sqlToQuery(captured[0]!);
    expect(rendered.sql).toContain(`"outbox_events"."organization_id"`);
    expect(rendered.sql).toContain(`"outbox_events"."delivery_state"`);
    expect(rendered.params).toContain(ORG);
    expect(rendered.params).toContain("DEAD");
    expect(rendered.params).toContain(OUTBOX_REPLAY_BATCH);
  });

  it("narrows to one event type when asked, and to none when not", async () => {
    const narrowed = makeTx([]);
    await replayOrgDeadLetters(narrowed.tx, ORG, "kb.content.index");
    expect(dialect.sqlToQuery(narrowed.captured[0]!).params).toContain("kb.content.index");

    const wide = makeTx([]);
    await replayOrgDeadLetters(wide.tx, ORG);
    expect(dialect.sqlToQuery(wide.captured[0]!).sql).not.toContain(`"event_type"`);
  });
});

describe("OutboxReplayService.replayDeadLetters", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("drains every tenant through forEachOrg and totals what it requeued", async () => {
    const { tx } = makeTx([{ id: 1 }, { id: 2 }]);
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const result = await new OutboxReplayService({} as unknown as Db).replayDeadLetters();

    expect(result.replayed).toBe(2);
    expect(result.organizationsProcessed).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("skips every tenant but the one named", async () => {
    const { tx } = makeTx([{ id: 1 }]);
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx, "org-other");
      await fn(tx, ORG);
      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    const result = await new OutboxReplayService({} as unknown as Db).replayDeadLetters({
      organizationId: ORG,
    });

    expect(result.replayed).toBe(1);
  });

  it("reports truncation when a tenant filled the batch", async () => {
    const { tx } = makeTx(Array.from({ length: OUTBOX_REPLAY_BATCH }, (_v, i) => ({ id: i })));
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const result = await new OutboxReplayService({} as unknown as Db).replayDeadLetters();
    expect(result.truncated).toBe(true);
  });
});
