import { NotificationTemplateRenderer } from "./notification-template-renderer.service";
import { NotificationDigestService } from "./notification-digest.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import type { DispatchEventInput } from "./notification.types";
import { Test } from "@nestjs/testing";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import {
  registerAfterCommit,
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../common/tenant/tenant-context";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationDispatchPersistenceService } from "./notification-dispatch-persistence.service";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService } from "./notifications.service";

const ORG = "org-a";
const USER = "user-1";

/**
 * Two failures are pinned here, and they are opposites.
 *
 * The first: a fire-and-forget dispatch that runs on the request's own transaction
 * handle hits it after commit, when the handle has been released to the pool and the
 * transaction-local tenant GUC is gone — every write then dies with SQLSTATE 42501.
 * Nothing had ever been written to `notifications`.
 *
 * The second: deferring with an in-memory hook and catching its failure into a log
 * loses the notification outright whenever the process dies between commit and drain.
 * `emit` now records the intent inside the caller's transaction first, so the drain is
 * an optimisation rather than the only chance — and a failed drain is a retry.
 */
describe("NotificationDispatchService durability", () => {
  const resolveDefinition = jest.fn();

  const DEFINITION = {
    eventKey: "organization.member.left",
    sourceModule: "organization",
    category: "SECURITY",
    displayName: "Member left",
    description: "Member left",
    defaultPriority: "NORMAL",
    defaultType: "INFO",
    defaultChannels: ["IN_APP"],
    allowedChannels: ["IN_APP"],
    mandatory: false,
    userConfigurable: true,
    adminConfigurable: true,
    quietHoursBehavior: "respect",
    dedupeWindowSeconds: 60,
    rateLimitWindowSeconds: 0,
    rateLimitMax: 0,
  };

  interface MockDb {
    transaction: jest.Mock;
    select: jest.Mock;
    execute: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
  }

  const insertedValues: Array<Record<string, unknown>> = [];
  const updatedValues: Array<Record<string, unknown>> = [];

  const db: MockDb = {
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (Array.isArray(v))
          for (const row of v) insertedValues.push(row);
        else
          insertedValues.push(v);
        return { onConflictDoNothing: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        updatedValues.push(v);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
  };

  let svc: NotificationDispatchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    insertedValues.length = 0;
    updatedValues.length = 0;
    resolveDefinition.mockResolvedValue({ definition: DEFINITION, enabled: false });

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        NotificationDispatchPersistenceService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationEventRegistryService, useValue: { resolveDefinition } },
        { provide: NotificationRoutingService, useValue: { routeMany: jest.fn() } },
        { provide: NotificationsService, useValue: { announce: jest.fn() } },
        { provide: CacheService, useValue: { cached: jest.fn() } },
        // PIPE-003 added this dependency. The events under test declare no
        // visibilityResourceKind, so canSee is never reached; it is here to satisfy DI.
        {
          provide: NotificationVisibilityRegistry,
          useValue: { canSee: jest.fn().mockResolvedValue(true) },
        },
        // Added when template rendering was split out of the dispatch service; these
        // events declare no templateKey, so loadTemplates returns an empty map.
        {
          provide: NotificationTemplateRenderer,
          useValue: { loadTemplates: jest.fn().mockResolvedValue(new Map()) },
        },
        // These users hold no digest preference, so dispatch sends immediately and
        // enqueue is never reached; the stub exists only to satisfy injection.
        {
          provide: NotificationDigestService,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    svc = moduleRef.get(NotificationDispatchService);
  });

  function inRequestTransaction<T>(
    afterCommit: AfterCommitHook[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const context = {
      orgId: ORG,
      audience: "INTERNAL",
      tx: db,
      afterCommit,
    } as unknown as TenantContext;
    return runWithTenantContext(context, fn);
  }

  // REG-005: eventKey is now a union derived from the catalog, so this must be
  // typed as DispatchEventInput rather than inferred as { eventKey: string }.
  const input: DispatchEventInput = {
    eventKey: "organization.member.left",
    orgId: ORG,
    targetUserIds: [USER],
  };

  function setsTenantGuc(): boolean {
    return JSON.stringify(db.execute.mock.calls).includes("app.organization_id");
  }

  it("records the intent inside the caller's transaction before dispatching anything", async () => {
    const afterCommit: AfterCommitHook[] = [];

    const result = await inRequestTransaction(afterCommit, () => svc.emit(input));

    expect(result.deferred).toBe(true);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      orgId: ORG,
      eventKey: input.eventKey,
      targetUserIds: [USER],
    });
    // The intent is durable; the pipeline itself has not run yet.
    expect(resolveDefinition).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
  });

  it("emitMany records every intent in ONE outbox insert inside the caller's transaction", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const second: DispatchEventInput = { ...input, targetUserIds: ["user-2"] };

    await inRequestTransaction(afterCommit, () => svc.emitMany([input, second]));

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertedValues.map((row) => row["targetUserIds"])).toEqual([[USER], ["user-2"]]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(2);
  });

  /**
   * Two transactions, and the second one is the point. After-commit hooks run once the
   * request's transaction has already returned, so there is no ambient context: both
   * the dispatch AND the mark have to open their own, or the mark hits `notification_outbox`
   * — an RLS table — on a handle with no tenant GUC and is refused 42501. An unmarked
   * row is re-dispatched by the relay, which for an event with no dedupe window is a
   * second notification rather than a no-op.
   */
  it("drains the intent as soon as the caller's transaction commits, marking it in its own tenant transaction", async () => {
    const afterCommit: AfterCommitHook[] = [];
    await inRequestTransaction(afterCommit, () => svc.emit(input));

    await afterCommit[0]?.();

    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(setsTenantGuc()).toBe(true);
    expect(resolveDefinition).toHaveBeenCalledWith(ORG, input.eventKey);
    expect(updatedValues).toContainEqual(expect.objectContaining({ state: "PROCESSED" }));
  });

  /**
   * The drain must not swallow. The intent is already committed, so surfacing the
   * failure costs nothing and is the difference between a visible retry and the silent
   * outage this pipeline has had before: the interceptor logs a rejected hook at error
   * and routes it through reportError.
   */
  it("surfaces a failed drain and leaves the intent PENDING for the relay", async () => {
    const afterCommit: AfterCommitHook[] = [];
    resolveDefinition.mockRejectedValue(new Error("42501 no tenant context"));

    await inRequestTransaction(afterCommit, () => svc.emit(input));

    await expect(afterCommit[0]?.()).rejects.toThrow("42501");
    // Never marked PROCESSED — the relay must still find it.
    expect(updatedValues).not.toContainEqual(expect.objectContaining({ state: "PROCESSED" }));
  });

  it("dispatches synchronously when there is no transaction to record the intent in", async () => {
    const result = await svc.emit(input);

    expect(result.deferred).toBe(false);
    expect(insertedValues).toHaveLength(0);
    expect(resolveDefinition).toHaveBeenCalledWith(ORG, input.eventKey);
    expect(setsTenantGuc()).toBe(true);
  });

  /**
   * The dedupe key carries no timestamp and outbox rows are never deleted, so a key
   * built only from (event, entity, targets) would collapse the second comment on a
   * ticket into the first — permanently, and silently, via onConflictDoNothing.
   */
  it("gives two genuine emissions of the same event distinct dedupe keys", async () => {
    await inRequestTransaction([], () => svc.emit(input));
    await inRequestTransaction([], () => svc.emit(input));

    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0]?.dedupeKey).not.toEqual(insertedValues[1]?.dedupeKey);
  });

  it("keeps an explicit dedupe key stable so a replayed consumer cannot double-notify", async () => {
    const replayed: DispatchEventInput = { ...input, dedupeKey: "outbox-event-7" };

    await inRequestTransaction([], () => svc.emit(replayed));
    await inRequestTransaction([], () => svc.emit(replayed));

    expect(insertedValues[0]?.dedupeKey).toEqual(insertedValues[1]?.dedupeKey);
  });

  function makePassedTx() {
    const rows: Array<Record<string, unknown>> = [];
    const tx = {
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((v: Array<Record<string, unknown>>) => {
          rows.push(...v);
          return { onConflictDoNothing: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    return { tx, rows };
  }

  it("emitInTx writes the intent on the passed transaction, not the ambient one, and drains only after commit", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const passed = makePassedTx();

    await inRequestTransaction(afterCommit, () =>
      svc.emitInTx(passed.tx as unknown as Parameters<typeof svc.emitInTx>[0], [input]),
    );

    expect(passed.rows).toHaveLength(1);
    expect(passed.rows[0]).toMatchObject({ orgId: ORG, eventKey: input.eventKey });
    expect(insertedValues).toHaveLength(0);
    expect(resolveDefinition).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);

    await afterCommit[0]?.();
    expect(resolveDefinition).toHaveBeenCalledWith(ORG, input.eventKey);
  });

  it("emitInTx outside a request context still records the intent on the tx and never dispatches inline over the network", async () => {
    const passed = makePassedTx();

    await svc.emitInTx(passed.tx as unknown as Parameters<typeof svc.emitInTx>[0], [input]);

    expect(passed.rows).toHaveLength(1);
    expect(resolveDefinition).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("emitInTx records several events in one outbox insert and drains each after commit", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const passed = makePassedTx();
    const second: DispatchEventInput = { ...input, targetUserIds: ["user-2"] };

    await inRequestTransaction(afterCommit, () =>
      svc.emitInTx(passed.tx as unknown as Parameters<typeof svc.emitInTx>[0], [input, second]),
    );

    expect(passed.tx.insert).toHaveBeenCalledTimes(1);
    expect(passed.rows).toHaveLength(2);
    expect(afterCommit).toHaveLength(2);
  });

  it("emitInTx writes nothing when given no events", async () => {
    const passed = makePassedTx();

    await svc.emitInTx(passed.tx as unknown as Parameters<typeof svc.emitInTx>[0], []);

    expect(passed.tx.insert).not.toHaveBeenCalled();
  });

  it("does not queue a hook outside a request transaction", () => {
    expect(registerAfterCommit(() => Promise.resolve())).toBe(false);
  });
});
