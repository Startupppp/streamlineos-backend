jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn().mockResolvedValue(["user-1"]),
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService } from "./notifications.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { NotificationTemplateRenderer } from "./notification-template-renderer.service";
import { NotificationDigestService } from "./notification-digest.service";
import type { DispatchEventInput } from "./notification.types";

const ORG = "org-a";
const USER = "user-1";
const FIXED_DEDUPE_KEY = "outbox-row-7";

const DEFINITION = {
  eventKey: "build.ticket.assigned",
  sourceModule: "build",
  category: "PROJECTS",
  displayName: "New comment",
  description: "Someone commented",
  defaultPriority: "NORMAL",
  defaultType: "INFO",
  defaultChannels: ["IN_APP"] as const,
  allowedChannels: ["IN_APP"] as const,
  mandatory: false,
  userConfigurable: true,
  adminConfigurable: true,
  quietHoursBehavior: "respect" as const,
  dedupeWindowSeconds: 0,
  rateLimitWindowSeconds: 0,
  rateLimitMax: 0,
};

const ROUTING = new Map([
  [
    USER,
    {
      createInApp: true,
      channels: [{ channel: "IN_APP" as const, action: "SEND" as const }],
      priority: "NORMAL" as const,
      reasonText: "targeted",
      deferredUntil: null,
    },
  ],
]);

interface MockDb {
  transaction: jest.Mock;
  execute: jest.Mock;
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
}

describe("NotificationDispatchService — idempotent materialization under relay replay", () => {
  let deliveryInsertCount = 0;
  const notifInsertedValues: Array<Record<string, unknown>> = [];

  const db: MockDb = {
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        if ("idempotencyKey" in v) {
          const n = deliveryInsertCount++;
          return {
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue(n === 0 ? [{ id: 1 }] : []),
            }),
          };
        }
        notifInsertedValues.push(v);
        return {
          returning: jest.fn().mockResolvedValue([{ id: 100, createdAt: new Date() }]),
        };
      }),
    })),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
  };

  let svc: NotificationDispatchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    deliveryInsertCount = 0;
    notifInsertedValues.length = 0;

    db.transaction.mockImplementation((fn: (t: MockDb) => Promise<unknown>) => fn(db));
    db.execute.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: NotificationEventRegistryService,
          useValue: {
            resolveDefinition: jest.fn().mockResolvedValue({ definition: DEFINITION, enabled: true }),
          },
        },
        {
          provide: NotificationRoutingService,
          useValue: { routeMany: jest.fn().mockResolvedValue(ROUTING) },
        },
        { provide: NotificationsService, useValue: { announce: jest.fn() } },
        {
          provide: NotificationVisibilityRegistry,
          useValue: { canSee: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: NotificationTemplateRenderer,
          useValue: { loadTemplates: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: NotificationDigestService,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    svc = moduleRef.get(NotificationDispatchService);
  });

  const input: DispatchEventInput = {
    eventKey: "build.ticket.assigned",
    orgId: ORG,
    targetUserIds: [USER],
    entityType: "ticket",
    entityId: "42",
    dedupeKey: FIXED_DEDUPE_KEY,
  };

  it("first dispatch creates exactly one notification row", async () => {
    const r = await svc.emitNow(input);
    expect(r.notified).toBe(1);
    expect(notifInsertedValues).toHaveLength(1);
  });

  it("relay replay with the same dedupe key returns deduped and creates no second notification row", async () => {
    await svc.emitNow(input);
    const r2 = await svc.emitNow(input);

    expect(r2.deduped).toBeGreaterThan(0);
    expect(r2.notified).toBe(0);
    expect(notifInsertedValues).toHaveLength(1);
  });

  it("unread count cannot double after a replay — no second notification row is inserted", async () => {
    await svc.emitNow(input);
    await svc.emitNow(input);

    const unreadRows = notifInsertedValues.filter((r) => r["isRead"] !== true);
    expect(unreadRows).toHaveLength(1);
  });
});
