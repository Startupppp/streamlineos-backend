import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { WebhookEndpointService } from "../../../integrations/core/webhook-endpoint.service";
import { listWebhooksQuerySchema } from "../dto/webhook.schemas";
import { AccessService } from "../../../access/access.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

jest.mock("../project-crud/project-access", () => ({
  assertProjectVisible: jest.fn().mockResolvedValue(undefined),
  assertCanManageProject: jest.fn().mockResolvedValue(undefined),
}));

const ACTOR: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const endpointStub = { deliveryStats: jest.fn().mockResolvedValue(new Map()) } as unknown as WebhookEndpointService;

function sqlValues(node: unknown, seen = new Set<object>()): unknown[] {
  if (node === null || node === undefined || typeof node !== "object") return [node];
  if (node instanceof Date) return [node];
  if (seen.has(node as object)) return [];
  seen.add(node as object);
  if (Array.isArray(node)) return node.flatMap((item) => sqlValues(item, seen));
  const obj = node as Record<string, unknown>;
  return [
    ...(Array.isArray(obj.queryChunks) ? sqlValues(obj.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(obj, "value") ? sqlValues(obj.value, seen) : []),
  ];
}

function sqlColumnNames(node: unknown, seen = new Set<object>()): string[] {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (node instanceof Date) return [];
  if (seen.has(node as object)) return [];
  seen.add(node as object);
  if (Array.isArray(node)) return node.flatMap((item) => sqlColumnNames(item, seen));
  const obj = node as Record<string, unknown>;
  const own = typeof obj.name === "string" && obj.table !== undefined ? [obj.name] : [];
  return [
    ...own,
    ...(Array.isArray(obj.queryChunks) ? sqlColumnNames(obj.queryChunks, seen) : []),
  ];
}

describe("listWebhooksQuerySchema — from/to date filter", () => {
  it("accepts a from date string so a deep-linked date range no longer 400s", () => {
    const result = listWebhooksQuerySchema.safeParse({ from: "2026-01-01" });
    expect(result.success).toBe(true);
    expect(result.data?.from).toBeInstanceOf(Date);
  });

  it("accepts a to date string (paired positive with from)", () => {
    const result = listWebhooksQuerySchema.safeParse({ to: "2026-12-31" });
    expect(result.success).toBe(true);
    expect(result.data?.to).toBeInstanceOf(Date);
  });

  it("accepts from and to together — a date range is not rejected", () => {
    const result = listWebhooksQuerySchema.safeParse({ from: "2026-01-01", to: "2026-12-31" });
    expect(result.success).toBe(true);
  });

  it("rejects a range whose to precedes from, so an impossible window is a 400 and not an always-empty list", () => {
    const result = listWebhooksQuerySchema.safeParse({ from: "2026-12-31", to: "2026-01-01" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["to"]);
  });

  it("accepts a range whose to equals from, so a single-day window is not rejected (BE-141 positive pair)", () => {
    expect(
      listWebhooksQuerySchema.safeParse({ from: "2026-05-05", to: "2026-05-05" }).success,
    ).toBe(true);
  });

  it("does not reject a lone to that precedes the epoch-defaulted from, because from is genuinely absent", () => {
    expect(listWebhooksQuerySchema.safeParse({ to: "1970-01-02" }).success).toBe(true);
  });

  it("still rejects an unknown key so .strict() is maintained after adding from/to", () => {
    expect(listWebhooksQuerySchema.safeParse({ unknown: "value" }).success).toBe(false);
  });

  it("accepts all existing filter keys alongside the new ones", () => {
    const result = listWebhooksQuerySchema.safeParse({
      state: "active",
      event: "ticket.created",
      q: "https://",
      cursor: 42,
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(result.success).toBe(true);
  });
});

describe("ProjectsWebhooksService.listWebhooks — from/to narrows results", () => {
  function makeDb(captureWhere: (condition: unknown) => void) {
    return {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((condition: unknown) => {
            captureWhere(condition);
            return {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            };
          }),
        }),
      }),
    };
  }

  it("includes the from date value in the WHERE clause so the filter narrows results server-side", async () => {
    let capturedWhere: unknown;
    const db = makeDb((c) => { capturedWhere = c; });
    const module = await Test.createTestingModule({
      providers: [ProjectsWebhooksService, { provide: DRIZZLE, useValue: db }, { provide: WebhookEndpointService, useValue: endpointStub }, { provide: AccessService, useValue: {} }, { provide: ProjectsWebhooksDispatchService, useValue: {} }],
    }).compile();
    const from = new Date("2026-06-01T00:00:00.000Z");
    await module.get(ProjectsWebhooksService).listWebhooks(ACTOR, 1, { from });
    const values = sqlValues(capturedWhere);
    expect(values).toContainEqual(from);
    await module.close();
  });

  it("includes the to date value in the WHERE clause (BE-141 positive pair)", async () => {
    let capturedWhere: unknown;
    const db = makeDb((c) => { capturedWhere = c; });
    const module = await Test.createTestingModule({
      providers: [ProjectsWebhooksService, { provide: DRIZZLE, useValue: db }, { provide: WebhookEndpointService, useValue: endpointStub }, { provide: AccessService, useValue: {} }, { provide: ProjectsWebhooksDispatchService, useValue: {} }],
    }).compile();
    const to = new Date("2026-12-31T00:00:00.000Z");
    await module.get(ProjectsWebhooksService).listWebhooks(ACTOR, 1, { to });
    const values = sqlValues(capturedWhere);
    expect(values).toContainEqual(to);
    await module.close();
  });

  it("windows on created_at and never on the delivery timestamp, so from/to means when the webhook was registered", async () => {
    let capturedWhere: unknown;
    const db = makeDb((c) => { capturedWhere = c; });
    const module = await Test.createTestingModule({
      providers: [ProjectsWebhooksService, { provide: DRIZZLE, useValue: db }, { provide: WebhookEndpointService, useValue: endpointStub }, { provide: AccessService, useValue: {} }, { provide: ProjectsWebhooksDispatchService, useValue: {} }],
    }).compile();
    await module.get(ProjectsWebhooksService).listWebhooks(ACTOR, 1, {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-30T00:00:00.000Z"),
    });
    const names = sqlColumnNames(capturedWhere);
    expect(names).toContain("created_at");
    expect(names).not.toContain("delivered_at");
    await module.close();
  });

  it("omits the from predicate when from is not provided so an undated list is not filtered", async () => {
    let capturedWhere: unknown;
    const db = makeDb((c) => { capturedWhere = c; });
    const module = await Test.createTestingModule({
      providers: [ProjectsWebhooksService, { provide: DRIZZLE, useValue: db }, { provide: WebhookEndpointService, useValue: endpointStub }, { provide: AccessService, useValue: {} }, { provide: ProjectsWebhooksDispatchService, useValue: {} }],
    }).compile();
    const sentinelDate = new Date("2026-06-01T00:00:00.000Z");
    await module.get(ProjectsWebhooksService).listWebhooks(ACTOR, 1, {});
    const values = sqlValues(capturedWhere);
    expect(values).not.toContainEqual(sentinelDate);
    await module.close();
  });
});
