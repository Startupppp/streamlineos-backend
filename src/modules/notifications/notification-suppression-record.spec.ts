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
import type { DispatchEventInput } from "./notification.types";

jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn().mockResolvedValue(["user-1"]),
}));

const ORG = "org-a";
const USER = "user-1";

const DEFINITION = {
  eventKey: "build.ticket.assigned",
  sourceModule: "build",
  category: "PROJECTS",
  displayName: "New comment",
  description: "Someone commented on a ticket",
  defaultPriority: "NORMAL",
  defaultType: "INFO",
  defaultChannels: ["IN_APP"] as const,
  allowedChannels: ["IN_APP"] as const,
  mandatory: false,
  userConfigurable: true,
  adminConfigurable: true,
  quietHoursBehavior: "respect",
  dedupeWindowSeconds: 0,
  rateLimitWindowSeconds: 0,
  rateLimitMax: 0,
  visibilityResourceKind: "ticket" as const,
};

describe("NotificationDispatchService — suppression recorded, not silently dropped", () => {
  const insertedRows: Array<Record<string, unknown>> = [];
  const resolveDefinition = jest.fn();
  const canSee = jest.fn();

  interface MockDb {
    transaction: jest.Mock;
    select: jest.Mock;
    execute: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
  }

  const db: MockDb = {
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockImplementation((projection?: Record<string, unknown>) => {
      const keys = projection ? Object.keys(projection) : [];
      const rows =
        keys.includes("userId") && keys.includes("id") ? [{ userId: USER, id: 1 }] : [];
      return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) };
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        insertedRows.push(v);
        return {
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
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
    insertedRows.length = 0;
    resolveDefinition.mockResolvedValue({ definition: DEFINITION, enabled: true });
    canSee.mockResolvedValue(false);

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        NotificationDispatchPersistenceService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationEventRegistryService, useValue: { resolveDefinition } },
        {
          provide: NotificationRoutingService,
          useValue: {
            routeMany: jest.fn().mockResolvedValue(
              new Map([
                [
                  USER,
                  {
                    createInApp: true,
                    channels: [{ channel: "IN_APP", action: "SEND" }],
                    priority: "NORMAL",
                    reasonText: "you were targeted",
                    deferredUntil: null,
                  },
                ],
              ]),
            ),
          },
        },
        { provide: NotificationsService, useValue: { announce: jest.fn() } },
        { provide: NotificationVisibilityRegistry, useValue: { canSee } },
        { provide: NotificationTemplateRenderer, useValue: { loadTemplates: jest.fn().mockResolvedValue(new Map()) } },
        { provide: NotificationDigestService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
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
  };

  it("writes a SUPPRESSED delivery row when the recipient has lost visibility", async () => {
    canSee.mockResolvedValue(false);
    await svc.emitNow(input);

    const suppressed = insertedRows.find(
      (r) => r["status"] === "SUPPRESSED" && r["suppressionReason"] === "NO_ACCESS",
    );
    expect(suppressed).toBeDefined();
    expect(suppressed?.["userId"]).toBe(USER);
    expect(suppressed?.["orgId"]).toBe(ORG);
  });

  it("includes an idempotency key on the suppressed row so a replay cannot double-record", async () => {
    await svc.emitNow(input);

    const suppressed = insertedRows.find((r) => r["status"] === "SUPPRESSED");
    expect(suppressed?.["idempotencyKey"]).toBeTruthy();
  });

  it("increments the suppressed counter on the result", async () => {
    const result = await svc.emitNow(input);
    expect(result.suppressed).toBeGreaterThan(0);
  });

  it("does not create an in-app notification row when the recipient is suppressed", async () => {
    await svc.emitNow(input);

    const inAppRow = insertedRows.find(
      (r) => r["status"] !== "SUPPRESSED",
    );
    expect(inAppRow).toBeUndefined();
  });
});
