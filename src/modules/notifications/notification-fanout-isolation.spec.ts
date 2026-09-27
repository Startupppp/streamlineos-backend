/**
 * One bad recipient used to cost the other 499 theirs.
 *
 * `perRecipient` had no try/catch, and ten of them run under one `Promise.all`
 * (`FANOUT_CONCURRENCY`). So a single recipient's failure — a missing membership
 * row, a template that throws on their locale, a visibility resolver that errors —
 * rejected the whole wave, threw out of `dispatch`, rolled the tenant transaction
 * back, and let `NotificationOutboxRelayService` increment `attempt_count`. A
 * deterministically bad recipient therefore burned all five attempts and DEADed the
 * entire chunk. The comment above the loop asserted recipients were independent
 * "each has its own idempotency key"; they had no error isolation at all.
 */
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationDispatchPersistenceService } from "./notification-dispatch-persistence.service";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService } from "./notifications.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { NotificationTemplateRenderer } from "./notification-template-renderer.service";
import { NotificationDigestService } from "./notification-digest.service";
import type { NotificationEventKey } from "./notification-events.catalog";

jest.mock("../../common/tenant/org-membership", () => ({
  // Returns the ids that are ACTIVE members — every target here is.
  filterOrgMemberIds: jest.fn(async (_db: unknown, _orgId: string, ids: readonly string[]) => [...ids]),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  // `emitNow` opens its own tenant transaction; the fanout under test runs inside it.
  runInNewTenantTransaction: jest.fn(
    (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  ),
}));

const TARGETS = ["user-1", "user-2", "user-3", "user-4", "user-5"];
const POISON = "user-3";

/**
 * The catalog key for a chat mention is `chat.message.mention`; this spec used to say
 * `chat.mention`, which has never existed in `NOTIFICATION_EVENT_CATALOG`. Annotated
 * with `NotificationEventKey` rather than left to widen to `string`, so a catalog
 * rename fails the typecheck here instead of leaving the spec exercising a ghost event.
 */
const EVENT_KEY: NotificationEventKey = "chat.message.mention";

const DEFINITION = {
  eventKey: EVENT_KEY,
  displayName: "You were mentioned",
  description: "A mention",
  category: "CHAT",
  sourceModule: "chat",
  defaultChannels: ["IN_APP"],
  allowedChannels: ["IN_APP"],
  mandatory: false,
  defaultPriority: "NORMAL",
  defaultType: "INFO",
  userConfigurable: true,
  adminConfigurable: true,
  quietHoursBehavior: "respect",
  dedupeWindowSeconds: 60,
  rateLimitWindowSeconds: 0,
  rateLimitMax: 0,
};

describe("notification fanout — one recipient cannot take the chunk down", () => {
  let dispatch: NotificationDispatchService;
  const persistForUser = jest.fn();
  let membershipIdByUser: Map<string, number>;

  /**
   * A query builder that answers `[]` however far it is chained and wherever it is
   * awaited. `dispatch` runs several unrelated lookups (memberships, emails,
   * preferences, locales) before the fanout; none of them is what this spec is
   * about, and a chain stubbed one shape at a time breaks whenever an unrelated
   * lookup is added.
   */
  function queryResolving(rows: readonly unknown[]): unknown {
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop) {
        if (prop === "then")
          return (resolve: (r: readonly unknown[]) => unknown) => resolve(rows);
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  }

  /**
   * Only the membership lookup projects both `userId` and `id`; the email, locale
   * and digest lookups each project a different pair. Answering every select with
   * `[]` modelled a state the database cannot produce — an ACTIVE member with no
   * membership row — and the fanout now refuses that state rather than writing a
   * notification nobody can read.
   */
  function selectFor(projection?: Record<string, unknown>): unknown {
    const keys = projection ? Object.keys(projection) : [];
    if (keys.includes("userId") && keys.includes("id")) {
      return queryResolving(
        TARGETS.filter((u) => membershipIdByUser.has(u)).map((u) => ({
          userId: u,
          id: membershipIdByUser.get(u),
        })),
      );
    }
    return queryResolving([]);
  }

  beforeEach(async () => {
    membershipIdByUser = new Map(TARGETS.map((u, i) => [u, 100 + i]));
    persistForUser.mockReset();
    persistForUser.mockImplementation((_input: unknown, _def: unknown, userId: string) => {
      if (userId === POISON) return Promise.reject(new Error("membership row is gone"));
      return Promise.resolve({ createdInApp: true, queued: 1, suppressed: 0, deduped: false, announce: null, pushHandledByEngine: false });
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: DRIZZLE, useValue: { select: jest.fn(selectFor) } },
        {
          provide: NotificationEventRegistryService,
          useValue: { resolveDefinition: jest.fn().mockResolvedValue({ definition: DEFINITION, enabled: true }) },
        },
        {
          provide: NotificationRoutingService,
          useValue: {
            // `routeMany` takes a Set of user ids, not an array.
            routeMany: jest.fn(async (_org: string, users: Iterable<string>) =>
              new Map([...users].map((u) => [u, { userId: u, createInApp: true, channels: [], priority: "NORMAL", deferredUntil: null, reasonText: "" }])),
            ),
          },
        },
        { provide: NotificationsService, useValue: { announce: jest.fn() } },
        { provide: NotificationVisibilityRegistry, useValue: { canSee: jest.fn().mockResolvedValue(true) } },
        { provide: NotificationTemplateRenderer, useValue: { loadTemplates: jest.fn().mockResolvedValue(new Map()) } },
        { provide: NotificationDigestService, useValue: { enqueue: jest.fn() } },
        { provide: NotificationDispatchPersistenceService, useValue: { persistForUser, recordAccessSuppression: jest.fn() } },
      ],
    }).compile();

    dispatch = moduleRef.get(NotificationDispatchService);
    jest.spyOn(dispatch["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(dispatch["logger"], "warn").mockImplementation(() => undefined);
  });

  it("materialises every healthy recipient and counts the failure instead of throwing", async () => {
    const result = await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    // The head form rejected here, so `notified` was never read at all.
    expect(result.failedRecipients).toBe(1);
    expect(result.notified).toBe(TARGETS.length - 1);
    expect(persistForUser).toHaveBeenCalledTimes(TARGETS.length);
  });

  it("never swallows it — a deferred failure that logs nothing is an invisible outage", async () => {
    await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    const logged = jest.mocked(dispatch["logger"].error).mock.calls.map(String).join("\n");
    expect(logged).toContain(POISON);
    expect(logged).toContain("membership row is gone");
  });

  it("skips a recipient whose active membership disappeared between the filter and the fanout, rather than persisting a notification with no membership", async () => {
    persistForUser.mockResolvedValue({ createdInApp: true, queued: 1, suppressed: 0, deduped: false, announce: null, pushHandledByEngine: false });
    membershipIdByUser.delete("user-2");

    const result = await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    const persisted = persistForUser.mock.calls.map((call) => call[2] as string);
    expect(persisted).not.toContain("user-2");
    expect(persisted).toHaveLength(TARGETS.length - 1);
    expect(result.notified).toBe(TARGETS.length - 1);
    expect(result.suppressed).toBe(1);
    expect(result.failedRecipients).toBe(0);
  });

  it("never hands persistForUser a null membership, because the notifications table cannot store one", async () => {
    persistForUser.mockResolvedValue({ createdInApp: true, queued: 1, suppressed: 0, deduped: false, announce: null, pushHandledByEngine: false });
    membershipIdByUser.delete("user-4");

    await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    for (const call of persistForUser.mock.calls) {
      expect(typeof call[3]).toBe("number");
    }
  });

  it("logs the skipped recipient, so a revoked membership mid-fanout is not silent", async () => {
    persistForUser.mockResolvedValue({ createdInApp: true, queued: 1, suppressed: 0, deduped: false, announce: null, pushHandledByEngine: false });
    membershipIdByUser.delete("user-5");

    await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    const warned = jest.mocked(dispatch["logger"].warn).mock.calls.map(String).join("\n");
    expect(warned).toContain("user-5");
  });

  it("CONTROL: every recipient keeps its membership, so none is skipped and none is suppressed", async () => {
    persistForUser.mockResolvedValue({ createdInApp: true, queued: 1, suppressed: 0, deduped: false, announce: null, pushHandledByEngine: false });

    const result = await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    expect(persistForUser).toHaveBeenCalledTimes(TARGETS.length);
    expect(result.suppressed).toBe(0);
  });

  it("a wholly healthy fanout reports no failures", async () => {
    persistForUser.mockResolvedValue({ createdInApp: true, queued: 1, suppressed: 0, deduped: false, announce: null, pushHandledByEngine: false });

    const result = await dispatch.emitNow({
      eventKey: EVENT_KEY,
      orgId: "org-1",
      targetUserIds: TARGETS,
      notifySelf: true,
    });

    expect(result.failedRecipients).toBe(0);
    expect(result.notified).toBe(TARGETS.length);
  });
});
