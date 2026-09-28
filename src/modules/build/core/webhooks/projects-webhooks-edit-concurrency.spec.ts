import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { TicketVersionConflictException } from "../tickets/ticket-version-conflict.exception";
import { createWebhookSchema, updateWebhookSchema } from "../dto/webhook.schemas";
import { projectWebhookSchema } from "../dto/build-core-response.schemas";

const ORG = "org-1";
const PROJECT_ID = 7;
const WEBHOOK_ID = 42;

function returnedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    orgId: ORG,
    projectId: PROJECT_ID,
    url: "https://example.com/hook",
    events: ["ticket.created"],
    isActive: true,
    hasSecret: true,
    secretSetAt: new Date("2026-09-28T00:00:00.000Z"),
    version: 4,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
    ...overrides,
  };
}

async function webhooksService(
  storedVersion: number | undefined,
  updateReturnRows: Record<string, unknown>[] = [],
) {
  const versionRows =
    storedVersion === undefined ? [] : [returnedRow({ version: storedVersion })];
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(versionRows) }),
    }),
  });
  const updateReturning = jest.fn().mockResolvedValue(updateReturnRows);
  const set = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({ returning: updateReturning }),
  });
  const update = jest.fn().mockReturnValue({ set });
  const returning = jest.fn().mockResolvedValue([returnedRow({ version: 1 })]);
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });
  const db = {
    select,
    update,
    insert,
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID }) } },
  };
  const module = await Test.createTestingModule({
    providers: [ProjectsWebhooksService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return { service: module.get(ProjectsWebhooksService), module, select, update, set, values, returning, updateReturning };
}

describe("webhook update concurrency token", () => {
  it("stale token returns 409 with currentVersion in details and never runs the update", async () => {
    const { service, module, update } = await webhooksService(9);
    const error = await service
      .updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 3, isActive: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
    expect((error as TicketVersionConflictException).getStatus()).toBe(409);
    expect((error as TicketVersionConflictException).getResponse()).toMatchObject({
      details: { currentVersion: 9 },
    });
    expect(update).not.toHaveBeenCalled();
    await module.close();
  });

  it("matching token does not throw and runs the update query (BE-141 positive pair)", async () => {
    const { service, module, update } = await webhooksService(9, [returnedRow({ version: 10 })]);
    const result = await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, {
      version: 9,
      isActive: false,
    });
    expect(update).toHaveBeenCalled();
    expect(result.version).toBe(10);
    await module.close();
  });

  it("a row that vanished before the token check is 404, not 409", async () => {
    const { service, module } = await webhooksService(undefined);
    const error = await service
      .updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 1, isActive: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    await module.close();
  });

  it("a row updated by a racer between the read and the write returns 409, not a silent no-op", async () => {
    const { service, module } = await webhooksService(9, []);
    const error = await service
      .updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 9, isActive: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
    expect((error as TicketVersionConflictException).getResponse()).toMatchObject({
      details: { currentVersion: 9 },
    });
    await module.close();
  });

  it("writes url and events through the update, so edit no longer needs delete-and-recreate", async () => {
    const { service, module, set } = await webhooksService(2, [returnedRow({ version: 3 })]);
    await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, {
      version: 2,
      url: "https://new.example.com/hook",
      events: ["ticket.updated", "ticket.deleted"],
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://new.example.com/hook",
        events: ["ticket.updated", "ticket.deleted"],
      }),
    );
    await module.close();
  });

  it("does not write a field the caller omitted", async () => {
    const { service, module, set } = await webhooksService(2, [returnedRow({ version: 3 })]);
    await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 2, isActive: false });
    const written = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty("url");
    expect(written).not.toHaveProperty("events");
    expect(written).toHaveProperty("isActive", false);
    await module.close();
  });

  it("a body carrying only the token returns the stored row and never builds an empty SET, which Drizzle would throw on", async () => {
    const { service, module, update } = await webhooksService(4, []);
    const result = await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 4 });
    expect(update).not.toHaveBeenCalled();
    expect(result.version).toBe(4);
    expect(result.hasSecret).toBe(true);
    await module.close();
  });

  it("a token-only body on a stale token is still 409, so the empty-patch shortcut cannot skip the conflict check", async () => {
    const { service, module, update } = await webhooksService(9, []);
    const error = await service
      .updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 4 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
    expect((error as TicketVersionConflictException).getStatus()).toBe(409);
    expect(update).not.toHaveBeenCalled();
    await module.close();
  });

  it("does not let the caller's token overwrite the stored version column", async () => {
    const { service, module, set } = await webhooksService(2, [returnedRow({ version: 3 })]);
    await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 2, isActive: false });
    expect(set.mock.calls[0]?.[0]).not.toHaveProperty("version");
    await module.close();
  });
});

describe("webhook update validation cannot drift from create", () => {
  it("rejects a url that create also rejects, so update is not an SSRF bypass", () => {
    expect(createWebhookSchema.safeParse({ url: "not-a-url", events: ["a"] }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ version: 1, url: "not-a-url" }).success).toBe(false);
  });

  it("accepts the same url create accepts (BE-141 positive pair)", () => {
    expect(
      createWebhookSchema.safeParse({ url: "https://example.com/hook", events: ["a"] }).success,
    ).toBe(true);
    expect(
      updateWebhookSchema.safeParse({ version: 1, url: "https://example.com/hook" }).success,
    ).toBe(true);
  });

  it("rejects an empty events array on update exactly as create does", () => {
    expect(createWebhookSchema.safeParse({ url: "https://e.co/h", events: [] }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ version: 1, events: [] }).success).toBe(false);
  });

  it("rejects an empty event name on update exactly as create does", () => {
    expect(createWebhookSchema.safeParse({ url: "https://e.co/h", events: [""] }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ version: 1, events: [""] }).success).toBe(false);
  });

  it("refuses an update with no concurrency token", () => {
    expect(updateWebhookSchema.safeParse({ isActive: false }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ version: 1, isActive: false }).success).toBe(true);
  });

  it("refuses a token-only update at the boundary, so the service empty-patch guard is defence in depth rather than the only stop", () => {
    expect(updateWebhookSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ version: 1, isActive: true }).success).toBe(true);
  });

  it("refuses a secret on update, because there is no rotation path to record its age", () => {
    expect(updateWebhookSchema.safeParse({ version: 1, secret: "s" }).success).toBe(false);
  });
});

describe("webhook secret age is expressible without exposing the secret", () => {
  it("stamps secret_set_at when create mints the secret", async () => {
    const { service, module, values } = await webhooksService(1);
    await service.createWebhook(ORG, PROJECT_ID, "user-1", {
      url: "https://example.com/hook",
      events: ["ticket.created"],
    });
    const written = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.secretSetAt).toBeInstanceOf(Date);
    expect(written.secret).toEqual(expect.any(String));
    await module.close();
  });

  it("asks the database for hasSecret and secretSetAt but never for the secret column on create", async () => {
    const { service, module, returning } = await webhooksService(1);
    await service.createWebhook(ORG, PROJECT_ID, "user-1", {
      url: "https://example.com/hook",
      events: ["ticket.created"],
    });
    const projection = Object.keys(returning.mock.calls[0]?.[0] as Record<string, unknown>);
    expect(projection).toEqual(expect.arrayContaining(["hasSecret", "secretSetAt", "version", "updatedAt"]));
    expect(projection).not.toContain("secret");
    await module.close();
  });

  it("asks the database for hasSecret and secretSetAt but never for the secret column on update", async () => {
    const { service, module, updateReturning } = await webhooksService(2, [returnedRow({ version: 3 })]);
    await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 2, isActive: false });
    const projection = Object.keys(updateReturning.mock.calls[0]?.[0] as Record<string, unknown>);
    expect(projection).toEqual(expect.arrayContaining(["hasSecret", "secretSetAt", "version", "updatedAt"]));
    expect(projection).not.toContain("secret");
    await module.close();
  });

  it("never asks for the secret column on the pre-update read that the token-only shortcut returns", async () => {
    const { service, module, select } = await webhooksService(4, []);
    await service.updateWebhook(ORG, PROJECT_ID, WEBHOOK_ID, { version: 4 });
    const projection = Object.keys(select.mock.calls[0]?.[0] as Record<string, unknown>);
    expect(projection).toEqual(expect.arrayContaining(["hasSecret", "secretSetAt", "version"]));
    expect(projection).not.toContain("secret");
    await module.close();
  });

  it("derives hasSecret from a secret IS NOT NULL predicate rather than a stored flag", async () => {
    const { service, module, returning } = await webhooksService(1);
    await service.createWebhook(ORG, PROJECT_ID, "user-1", {
      url: "https://example.com/hook",
      events: ["ticket.created"],
    });
    const projection = returning.mock.calls[0]?.[0] as Record<string, { queryChunks?: unknown[] }>;
    const chunks = projection.hasSecret?.queryChunks ?? [];
    const rendered = chunks
      .map((chunk) => {
        const part = chunk as { value?: unknown; name?: unknown };
        if (Array.isArray(part.value)) return part.value.join("");
        if (typeof part.name === "string") return part.name;
        return "";
      })
      .join("");
    expect(rendered).toContain("IS NOT NULL");
    expect(rendered).toContain("secret");
    await module.close();
  });

  it("carries hasSecret, secretSetAt, version and updatedAt through the response contract", () => {
    const parsed = projectWebhookSchema.parse({
      ...returnedRow(),
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    });
    expect(parsed.hasSecret).toBe(true);
    expect(parsed.secretSetAt).not.toBeNull();
    expect(parsed.version).toBe(4);
    expect(parsed.updatedAt).not.toBeUndefined();
  });

  it("distinguishes a webhook with no secret from a secret of unknown age", () => {
    const noSecret = projectWebhookSchema.parse({
      ...returnedRow({ hasSecret: false, secretSetAt: null }),
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    });
    const unknownAge = projectWebhookSchema.parse({
      ...returnedRow({ hasSecret: true, secretSetAt: null }),
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    });
    expect([noSecret.hasSecret, noSecret.secretSetAt]).toEqual([false, null]);
    expect([unknownAge.hasSecret, unknownAge.secretSetAt]).toEqual([true, null]);
  });

  it("the inline list select and the write-path projection expose the same fields, so they cannot drift", async () => {
    const listKeys: string[] = [];
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID }) } },
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockImplementation((projection: Record<string, unknown>) => {
        listKeys.push(...Object.keys(projection));
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        };
      }),
    };
    const module = await Test.createTestingModule({
      providers: [ProjectsWebhooksService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    await module.get(ProjectsWebhooksService).listWebhooks(ORG, PROJECT_ID);

    const write = await webhooksService(1);
    await write.service.createWebhook(ORG, PROJECT_ID, "user-1", {
      url: "https://example.com/hook",
      events: ["ticket.created"],
    });
    const writeKeys = Object.keys(write.returning.mock.calls[0]?.[0] as Record<string, unknown>);

    expect(listKeys.sort()).toEqual(writeKeys.sort());
    await module.close();
    await write.module.close();
  });

  it("rejects a projection that omits hasSecret, so the field cannot vanish on decode", () => {
    const withoutHasSecret: Record<string, unknown> = {
      ...returnedRow(),
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    };
    delete withoutHasSecret.hasSecret;
    expect(projectWebhookSchema.safeParse(withoutHasSecret).success).toBe(false);
  });

  it("strips a secret smuggled into the response payload", () => {
    const parsed = projectWebhookSchema.parse({
      ...returnedRow(),
      secret: "leaked",
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    });
    expect(parsed).not.toHaveProperty("secret");
  });
});
