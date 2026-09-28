jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import type { Db } from "../../../../db/drizzle.module";
import { BuildNotificationContextService } from "./build-notification-context.service";
import type { AccessService } from "../../../access/access.service";
import type { MembershipStateService } from "../../../../common/auth/membership-state.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const mockRunInTenantTransaction = runInTenantTransaction as jest.Mock;

function buildMockTx(rows: unknown[]): { tx: unknown; captureWhere: () => unknown } {
  let capturedWhere: unknown;
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockImplementation((predicate: unknown) => {
    capturedWhere = predicate;
    return { limit };
  });
  const leftJoin2 = jest.fn().mockReturnValue({ where });
  const leftJoin1 = jest.fn().mockReturnValue({ leftJoin: leftJoin2 });
  const innerJoin = jest.fn().mockReturnValue({ leftJoin: leftJoin1 });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const tx = { select: jest.fn().mockReturnValue({ from }) };
  return { tx, captureWhere: () => capturedWhere };
}

function makeDeps() {
  const membership = {
    resolve: jest.fn().mockResolvedValue({
      active: true,
      membershipId: 42,
      isOwner: false,
      role: "MEMBER",
    }),
  } as unknown as MembershipStateService;
  const access = {
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as unknown as AccessService;
  const db = {} as unknown as Db;
  return { membership, access, db };
}

describe("BuildNotificationContextService — cross-tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("scopes the WHERE predicate to the requesting org, never a foreign org (tenant isolation — DENY)", async () => {
    const { db, access, membership } = makeDeps();
    const { tx, captureWhere } = buildMockTx([]);
    mockRunInTenantTransaction.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );

    const svc = new BuildNotificationContextService(db, access, membership);
    const result = await svc.resolve(ATTACKER_ORG, "u-attacker", [1, 2]);

    const wherePredicate = captureWhere();
    expect(wherePredicate).toBeDefined();
    const vals = sqlValues(wherePredicate);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("returns resolved ticket contexts for the owning org (same-tenant control — PASS)", async () => {
    const ticketRow = {
      id: 7,
      ticketNumber: 3,
      priority: "HIGH",
      status: "TODO",
      type: "TASK",
      projectKey: "PRJ",
      assigneeId: null,
      assigneeName: null,
      assigneeFirstName: null,
      assigneeLastName: null,
      assigneeImage: null,
    };
    const { db, access, membership } = makeDeps();
    const { tx, captureWhere } = buildMockTx([ticketRow]);
    mockRunInTenantTransaction.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );

    const svc = new BuildNotificationContextService(db, access, membership);
    const result = await svc.resolve(OWNER_ORG, "u-owner", [7]);

    const wherePredicate = captureWhere();
    expect(wherePredicate).toBeDefined();
    const vals = sqlValues(wherePredicate);
    expect(vals).toContain(OWNER_ORG);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);
    expect(result.get(7)).toMatchObject({ ticketId: 7, ticketKey: "PRJ-3" });
  });
});
