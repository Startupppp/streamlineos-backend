jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { IntegrationsService } from "./integrations.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const OWNER_USER = "user-owner";
const ATTACKER_USER = "user-attacker";

const mockConfig = { APP_URL: "http://localhost:3000" } as never;
const mockGateway = { initiateConnection: jest.fn(), getOwnedConnectedAccount: jest.fn() } as never;

function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where }),
    }),
  } as unknown as Db;
  return { db, where };
}

describe("IntegrationsService.listConnections — cross-tenant isolation", () => {
  it("scopes the query to the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new IntegrationsService(db, mockConfig, mockGateway);

    const result = await svc.listConnections(ATTACKER_ORG, ATTACKER_USER);

    expect(result).toHaveLength(0);
    const leafValues = sqlValues(where.mock.calls[0]?.[0]);
    expect(leafValues).toContain(ATTACKER_ORG);
    expect(leafValues).toContain(ATTACKER_USER);
  });

  it("returns connections for the owning org (same-tenant control)", async () => {
    const row = {
      id: 1,
      status: "active",
      toolkit: "gmail" as const,
      isPrimary: true,
      createdAt: new Date(),
      accountEmail: "alice@example.com",
      accountLabel: "alice@example.com",
    };
    const { db } = makeSelectDb([row]);
    const svc = new IntegrationsService(db, mockConfig, mockGateway);

    const result = await svc.listConnections(OWNER_ORG, OWNER_USER);

    expect(result).toHaveLength(1);
  });
});

describe("IntegrationsService.ownedConnection — cross-tenant isolation", () => {
  it("throws NotFoundException when connection belongs to a different org", async () => {
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const svc = new IntegrationsService(db, mockConfig, mockGateway);

    await expect(svc.ownedConnection(ATTACKER_ORG, ATTACKER_USER, 99)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("returns the connection for the owning org (same-tenant control)", async () => {
    const row = {
      id: 99,
      isPrimary: true,
      composioConnectedAccountId: "acc-1",
    };
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([row]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const svc = new IntegrationsService(db, mockConfig, mockGateway);

    const result = await svc.ownedConnection(OWNER_ORG, OWNER_USER, 99);
    expect(result).toMatchObject({ id: 99 });
  });
});
