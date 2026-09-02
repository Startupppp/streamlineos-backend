jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { IS_PUBLIC } from "../../common/auth/public.decorator";
import { VALIDATION_SCHEMAS, type ValidationSchemas } from "../../common/validation/validate.decorator";
import { CalendarModule } from "./calendar.module";
import { CalendarProviderWebhookController } from "./calendar-provider-webhook.controller";
import { CalendarProviderWebhookService, type WebhookHandleResult } from "./calendar-provider-webhook.service";
import { providerWebhookBodySchema } from "./dto/provider-webhook.schemas";
import type { Db } from "../../db/drizzle.module";

const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

const SECRET = "calendar-webhook-secret-value";
const ORG_A = "org-delivery-a";
const ORG_B = "org-delivery-b";
const EXT_ID = "google-evt-delivery";
const LOCAL_UPDATED_AT = new Date("2026-09-01T12:00:00Z");
const NEWER = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();

interface ConnectionRow {
  id: number;
  orgId: string;
}

interface EventRow {
  id: number;
  updatedAt: Date;
  localVersion: number;
  integrationConnectionId: number | null;
  externalEventId: string;
  createdByMembershipId: number;
}

interface ServiceHarness {
  db: Db;
  txOrgIds: string[];
  inserted: Record<string, unknown>[];
  connectionLookups: number;
}

function makeServiceHarness(options: {
  connections: ConnectionRow[];
  events: EventRow[];
  memberUserId?: string;
}): ServiceHarness {
  const { connections, events, memberUserId = "user-owner" } = options;
  const txOrgIds: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const lookups = { count: 0 };

  let selectCall = 0;
  const tx = {
    select: jest.fn().mockImplementation(() => {
      const callIdx = selectCall++;
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(callIdx === 0 ? events : []),
          }),
        }),
      };
    }),
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ userId: memberUserId }),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve([]);
      }),
    }),
  };

  mockedRunInTx.mockImplementation(async (_db, orgId, cb) => {
    txOrgIds.push(orgId);
    return cb(tx as never);
  });

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockImplementation(() => {
            lookups.count += 1;
            return Promise.resolve(connections);
          }),
        }),
      }),
    }),
  };

  return {
    db: db as unknown as Db,
    txOrgIds,
    inserted,
    get connectionLookups() {
      return lookups.count;
    },
  };
}

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 42,
    updatedAt: LOCAL_UPDATED_AT,
    localVersion: 3,
    integrationConnectionId: 7,
    externalEventId: EXT_ID,
    createdByMembershipId: 5,
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env.CALENDAR_PROVIDER_WEBHOOK_SECRET = SECRET;
});

afterAll(() => {
  delete process.env.CALENDAR_PROVIDER_WEBHOOK_SECRET;
});

describe("provider webhooks are actually delivered: the receiver is wired into the module graph", () => {
  it("registers the webhook controller on CalendarModule, so the route exists at runtime", () => {
    const controllers: unknown = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CalendarModule);
    expect(Array.isArray(controllers)).toBe(true);
    expect(controllers as unknown[]).toContain(CalendarProviderWebhookController);
  });

  it("exposes POST /webhooks/calendar/provider", () => {
    const controllerPath: unknown = Reflect.getMetadata(PATH_METADATA, CalendarProviderWebhookController);
    const handler = CalendarProviderWebhookController.prototype.handle;
    const routePath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);

    expect(controllerPath).toBe("webhooks/calendar");
    expect(routePath).toBe("provider");
    expect(method).toBe(RequestMethod.POST);
  });

  it("declares its exposure as public, so RouteClassifierGuard does not deny it at boot", () => {
    const isPublic: unknown = Reflect.getMetadata(IS_PUBLIC, CalendarProviderWebhookController);
    expect(isPublic).toBe(true);
  });

  it("validates its body with the strict delivery schema", () => {
    const schemas: ValidationSchemas | undefined = Reflect.getMetadata(
      VALIDATION_SCHEMAS,
      CalendarProviderWebhookController.prototype.handle,
    );
    expect(schemas?.body).toBe(providerWebhookBodySchema);
  });
});

describe("the delivery body carries no tenant selector", () => {
  it("accepts a connection-scoped delivery", () => {
    const parsed = providerWebhookBodySchema.safeParse({
      connectionId: 7,
      externalEventId: EXT_ID,
      providerUpdatedAt: NEWER,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a caller-supplied orgId outright", () => {
    const parsed = providerWebhookBodySchema.safeParse({
      connectionId: 7,
      externalEventId: EXT_ID,
      providerUpdatedAt: NEWER,
      orgId: ORG_B,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a delivery with no connection to resolve the tenant from", () => {
    const parsed = providerWebhookBodySchema.safeParse({
      externalEventId: EXT_ID,
      providerUpdatedAt: NEWER,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("the webhook authenticates before it does anything", () => {
  it("rejects a delivery with no secret and never reaches the service", async () => {
    const handleDelivery = jest.fn<Promise<WebhookHandleResult>, [unknown]>();
    const controller = new CalendarProviderWebhookController({
      handleDelivery,
    } as unknown as CalendarProviderWebhookService);

    await expect(
      controller.handle({ connectionId: 7, externalEventId: EXT_ID, providerUpdatedAt: NEWER }, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(handleDelivery).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret and never reaches the service", async () => {
    const handleDelivery = jest.fn<Promise<WebhookHandleResult>, [unknown]>();
    const controller = new CalendarProviderWebhookController({
      handleDelivery,
    } as unknown as CalendarProviderWebhookService);

    await expect(
      controller.handle(
        { connectionId: 7, externalEventId: EXT_ID, providerUpdatedAt: NEWER },
        "not-the-secret-value-xxxxxxxxx",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(handleDelivery).not.toHaveBeenCalled();
  });

  it("refuses every delivery when no secret is configured, rather than accepting unauthenticated ones", async () => {
    delete process.env.CALENDAR_PROVIDER_WEBHOOK_SECRET;
    const handleDelivery = jest.fn<Promise<WebhookHandleResult>, [unknown]>();
    const controller = new CalendarProviderWebhookController({
      handleDelivery,
    } as unknown as CalendarProviderWebhookService);

    await expect(
      controller.handle({ connectionId: 7, externalEventId: EXT_ID, providerUpdatedAt: NEWER }, SECRET),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(handleDelivery).not.toHaveBeenCalled();
  });

  it("passes an authenticated delivery through to the service and returns its action", async () => {
    const handleDelivery = jest
      .fn<Promise<WebhookHandleResult>, [unknown]>()
      .mockResolvedValue({ action: "requeued" });
    const controller = new CalendarProviderWebhookController({
      handleDelivery,
    } as unknown as CalendarProviderWebhookService);

    const response = await controller.handle(
      { connectionId: 7, externalEventId: EXT_ID, providerUpdatedAt: NEWER },
      SECRET,
    );

    expect(response).toEqual({ action: "requeued" });
    expect(handleDelivery).toHaveBeenCalledWith({
      connectionId: 7,
      externalEventId: EXT_ID,
      providerUpdatedAtIso: NEWER,
    });
  });
});

describe("the tenant comes from the connection row, never from the request", () => {
  it("opens every tenant transaction with the org stored on the connection", async () => {
    const harness = makeServiceHarness({
      connections: [{ id: 7, orgId: ORG_A }],
      events: [eventRow()],
    });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleDelivery({
      connectionId: 7,
      externalEventId: EXT_ID,
      providerUpdatedAtIso: NEWER,
    });

    expect(result.action).toBe("requeued");
    expect(harness.connectionLookups).toBe(1);
    expect(new Set(harness.txOrgIds)).toEqual(new Set([ORG_A]));
    expect(harness.inserted[0]).toMatchObject({ orgId: ORG_A, eventId: 42, connectionId: 7 });
  });

  it("drops a delivery naming a connection that does not resolve, and touches no tenant", async () => {
    const harness = makeServiceHarness({ connections: [], events: [eventRow()] });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleDelivery({
      connectionId: 999,
      externalEventId: EXT_ID,
      providerUpdatedAtIso: NEWER,
    });

    expect(result.action).toBe("unknown_connection");
    expect(harness.txOrgIds).toEqual([]);
    expect(harness.inserted).toEqual([]);
  });
});
