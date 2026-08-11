import { NotificationTemplateRenderer } from "./notification-template-renderer.service";
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
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService } from "./notifications.service";

const ORG = "org-a";
const USER = "user-1";

/**
 * A fire-and-forget dispatch that runs on the request's own transaction handle
 * hits it after commit, when the handle has been released to the pool and the
 * transaction-local tenant GUC is gone — every notification write then dies
 * with SQLSTATE 42501. Nothing had ever been written to `notifications`.
 */
describe("NotificationDispatchService transaction safety", () => {
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
  }

  const db: MockDb = {
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    execute: jest.fn().mockResolvedValue([]),
  };

  let svc: NotificationDispatchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    resolveDefinition.mockResolvedValue({ definition: DEFINITION, enabled: false });

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
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

  it("touches no database until the caller's transaction commits", async () => {
    const afterCommit: AfterCommitHook[] = [];

    const result = await inRequestTransaction(afterCommit, () => svc.emit(input));

    expect(result.deferred).toBe(true);
    expect(afterCommit).toHaveLength(1);
    expect(resolveDefinition).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("opens its own tenant transaction when the deferred hook runs", async () => {
    const afterCommit: AfterCommitHook[] = [];
    await inRequestTransaction(afterCommit, () => svc.emit(input));

    await afterCommit[0]?.();

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(setsTenantGuc()).toBe(true);
    expect(resolveDefinition).toHaveBeenCalledWith(ORG, input.eventKey);
  });

  it("dispatches immediately when there is no transaction to wait for", async () => {
    const result = await svc.emit(input);

    expect(result.deferred).toBe(false);
    expect(resolveDefinition).toHaveBeenCalledWith(ORG, input.eventKey);
    expect(setsTenantGuc()).toBe(true);
  });

  it("reports a deferred failure instead of swallowing it", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const { logger } = svc as unknown as { logger: { error: (message: string) => void } };
    const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    resolveDefinition.mockRejectedValue(new Error("42501 no tenant context"));

    await inRequestTransaction(afterCommit, () => svc.emit(input));
    await expect(afterCommit[0]?.()).resolves.not.toThrow();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("42501"));
  });

  it("does not queue a hook outside a request transaction", () => {
    expect(registerAfterCommit(() => Promise.resolve())).toBe(false);
  });
});
