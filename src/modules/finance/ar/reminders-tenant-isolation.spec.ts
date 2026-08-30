import { NotFoundException } from "@nestjs/common";
import { RemindersService } from "./reminders.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

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

function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["from", "where", "orderBy", "limit", "offset"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain["limit"] = jest.fn().mockResolvedValue(resolvedValue);
  chain["offset"] = jest.fn().mockReturnValue({
    ...chain,
    limit: jest.fn().mockResolvedValue(resolvedValue),
  });
  return chain;
}

function makeUpdateChain() {
  return {
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  };
}

function makeService(findFirst: jest.Mock, selectChain?: ReturnType<typeof makeSelectChain>) {
  const chain = selectChain ?? makeSelectChain([]);
  const db = {
    query: {
      finReminderPolicies: { findFirst },
    },
    select: jest.fn().mockReturnValue(chain),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
  } as unknown as Db;
  const audit = { log: jest.fn() } as unknown as AuditService;
  return new RemindersService(db, audit);
}

describe("RemindersService — cross-tenant isolation", () => {
  const POLICY_ID = 77;
  const ORG_A = "org-a";
  const ORG_ATTACKER = "org-attacker";

  describe("updatePolicy — cross-tenant DENY", () => {
    it("throws NotFoundException when attacker org requests another org's policy", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const service = makeService(findFirst);

      await expect(
        service.updatePolicy(ORG_ATTACKER, POLICY_ID, { name: "pwned" }),
      ).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledTimes(1);
      const args = findFirst.mock.calls[0]?.[0] as { where?: unknown };
      expect(sqlValues(args.where)).toContain(ORG_ATTACKER);
    });
  });

  describe("updatePolicy — same-tenant CONTROL", () => {
    it("returns the updated policy when called from the owning org", async () => {
      const existing = {
        id: POLICY_ID,
        orgId: ORG_A,
        name: "original",
        offsets: [3],
        channel: "EMAIL",
        template: null,
        isActive: true,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const findFirst = jest.fn().mockResolvedValue(existing);
      const service = makeService(findFirst);

      const result = await service.updatePolicy(ORG_A, POLICY_ID, { name: "renamed" });

      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(sqlValues(findFirst.mock.calls[0]?.[0].where)).toContain(ORG_A);
      expect(result).toBeDefined();
    });
  });

  describe("deletePolicy — cross-tenant DENY", () => {
    it("throws NotFoundException when attacker org targets another org's policy", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const service = makeService(findFirst);

      await expect(service.deletePolicy(ORG_ATTACKER, POLICY_ID)).rejects.toThrow(
        NotFoundException,
      );

      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(sqlValues(findFirst.mock.calls[0]?.[0].where)).toContain(ORG_ATTACKER);
    });
  });

  describe("deletePolicy — same-tenant CONTROL", () => {
    it("succeeds when called from the owning org", async () => {
      const existing = { id: POLICY_ID, orgId: ORG_A };
      const findFirst = jest.fn().mockResolvedValue(existing);
      const service = makeService(findFirst);

      const result = await service.deletePolicy(ORG_A, POLICY_ID);

      expect(result).toEqual({ success: true });
      expect(sqlValues(findFirst.mock.calls[0]?.[0].where)).toContain(ORG_A);
    });
  });

  describe("listPolicies — namespace isolation", () => {
    it("scopes the query to the calling org and not to any other", async () => {
      const findFirst = jest.fn();
      const chain = makeSelectChain([]);
      const service = makeService(findFirst, chain);

      await service.listPolicies(ORG_A, { cursor: 0, limit: 10 });

      expect(chain.from).toHaveBeenCalledTimes(1);
      expect(chain.where).toHaveBeenCalledTimes(1);
      const whereArg = chain.where.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(ORG_A);
      expect(sqlValues(whereArg)).not.toContain(ORG_ATTACKER);
    });
  });
});
