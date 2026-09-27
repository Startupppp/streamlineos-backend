/**
 * Validates recipient authorization at send time.
 *
 * The dispatch service calls filterOrgMemberIds before routing, so a targetUserId that
 * belongs to a different tenant — or whose membership is not ACTIVE — is stripped
 * before any notification row is created.  All existing specs mock filterOrgMemberIds to
 * return the requested user; this file exercises the paths where it does not.
 */
jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn(),
}));

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

const ORG = "org-a";
const MEMBER = "user-member";
const STRANGER = "user-other-org";

const DEFINITION = {
  eventKey: "build.ticket.assigned",
  sourceModule: "build",
  category: "PROJECTS",
  displayName: "Ticket assigned",
  description: "A ticket was assigned to you",
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
};

describe("NotificationDispatchService — recipient authorization at send time", () => {
  const { filterOrgMemberIds } = jest.requireMock("../../common/tenant/org-membership") as { filterOrgMemberIds: jest.Mock };

  const insertedRows: Array<Record<string, unknown>> = [];

  interface MockDb {
    transaction: jest.Mock;
    select: jest.Mock;
    execute: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
  }

  let activeMemberships = new Map<string, number>();

  const db: MockDb = {
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockImplementation((projection?: Record<string, unknown>) => {
      const keys = projection ? Object.keys(projection) : [];
      const rows =
        keys.includes("userId") && keys.includes("id")
          ? [...activeMemberships].map(([userId, id]) => ({ userId, id }))
          : [];
      return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) };
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        insertedRows.push(v);
        return {
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
          returning: jest.fn().mockResolvedValue([{ id: 1, createdAt: new Date() }]),
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
    activeMemberships = new Map([[MEMBER, 1]]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        NotificationDispatchPersistenceService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: NotificationEventRegistryService,
          useValue: {
            resolveDefinition: jest.fn().mockResolvedValue({ definition: DEFINITION, enabled: true }),
          },
        },
        {
          provide: NotificationRoutingService,
          useValue: {
            routeMany: jest.fn().mockImplementation(
              (_orgId: unknown, targets: string[]) =>
                Promise.resolve(
                  new Map(
                    targets.map((uid) => [
                      uid,
                      {
                        createInApp: true,
                        channels: [{ channel: "IN_APP" as const, action: "SEND" as const }],
                        priority: "NORMAL" as const,
                        reasonText: "targeted",
                        deferredUntil: null,
                      },
                    ]),
                  ),
                ),
            ),
          },
        },
        { provide: NotificationsService, useValue: { announce: jest.fn() } },
        { provide: NotificationVisibilityRegistry, useValue: { canSee: jest.fn().mockResolvedValue(true) } },
        { provide: NotificationTemplateRenderer, useValue: { loadTemplates: jest.fn().mockResolvedValue(new Map()) } },
        { provide: NotificationDigestService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = moduleRef.get(NotificationDispatchService);
  });

  it("creates no notification or delivery rows when all targets are non-members", async () => {
    filterOrgMemberIds.mockResolvedValue([]);

    const input: DispatchEventInput = {
      eventKey: "build.ticket.assigned",
      orgId: ORG,
      targetUserIds: [STRANGER],
    };

    const result = await svc.emitNow(input);

    expect(result.notified).toBe(0);
    expect(result.deliveriesQueued).toBe(0);
    const notifRows = insertedRows.filter((r) => !("dedupeKey" in r));
    expect(notifRows).toHaveLength(0);
  });

  it("returns notified=0 when filterOrgMemberIds returns empty — no notification row to count", async () => {
    filterOrgMemberIds.mockResolvedValue([]);

    const result = await svc.emitNow({
      eventKey: "build.ticket.assigned",
      orgId: ORG,
      targetUserIds: [STRANGER],
    });

    expect(result.notified).toBe(0);
  });

  it("notifies only the subset of targets that are active org members", async () => {
    filterOrgMemberIds.mockResolvedValue([MEMBER]);

    const result = await svc.emitNow({
      eventKey: "build.ticket.assigned",
      orgId: ORG,
      targetUserIds: [MEMBER, STRANGER],
    });

    expect(result.notified).toBe(1);
    const notifRow = insertedRows.find((r) => r["userId"] === MEMBER);
    expect(notifRow).toBeDefined();
    const strangerRow = insertedRows.find((r) => r["userId"] === STRANGER);
    expect(strangerRow).toBeUndefined();
  });

  it("bypassing filterOrgMemberIds alone is not enough — the membership lookup is a second gate and still blocks the stranger", async () => {
    filterOrgMemberIds.mockResolvedValue([MEMBER, STRANGER]);

    await svc.emitNow({
      eventKey: "build.ticket.assigned",
      orgId: ORG,
      targetUserIds: [MEMBER, STRANGER],
    });

    const strangerRow = insertedRows.find((r) => r["userId"] === STRANGER);
    expect(strangerRow).toBeUndefined();
    const memberRow = insertedRows.find((r) => r["userId"] === MEMBER);
    expect(memberRow).toBeDefined();
  });

  it("bites: bypassing both the member filter and the membership lookup produces the stranger row, so neither gate is inert", async () => {
    filterOrgMemberIds.mockResolvedValue([MEMBER, STRANGER]);
    activeMemberships.set(STRANGER, 2);

    await svc.emitNow({
      eventKey: "build.ticket.assigned",
      orgId: ORG,
      targetUserIds: [MEMBER, STRANGER],
    });

    const strangerRow = insertedRows.find((r) => r["userId"] === STRANGER);
    expect(strangerRow).toBeDefined();
  });
});
