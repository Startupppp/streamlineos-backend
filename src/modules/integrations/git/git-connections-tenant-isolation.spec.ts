import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { GitConnectionsService } from "./git-connections.service";

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
  const node = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(node.queryChunks ? sqlValues(node.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(node, "value")
      ? sqlValues(node.value, seen)
      : []),
  ];
}

describe("GitConnectionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    const where = jest.fn().mockImplementation((clause: unknown) => {
      wheres.push(clause);
      return {
        orderBy: jest
          .fn()
          .mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        returning: jest.fn().mockResolvedValue([]),
      };
    });
    return {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      update: jest
        .fn()
        .mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }),
      delete: jest.fn().mockReturnValue({ where }),
    } as unknown as Db;
  }

  it("scopes the connection list to the requesting org", async () => {
    const wheres: unknown[] = [];
    const service = new GitConnectionsService(makeDb(wheres));

    await service.listConnections(ATTACKER, { limit: 50 });

    const values = wheres.flatMap((clause) => sqlValues(clause));
    expect(values).toContain(ATTACKER);
    expect(values).not.toContain(OWNER);
  });

  it("re-asserts the org on an update, so a foreign connection id matches nothing", async () => {
    const wheres: unknown[] = [];
    const service = new GitConnectionsService(makeDb(wheres));

    await expect(
      service.updateConnection(ATTACKER, 1, { isActive: false }),
    ).rejects.toThrow(NotFoundException);

    const values = wheres.flatMap((clause) => sqlValues(clause));
    expect(values).toContain(ATTACKER);
    expect(values).not.toContain(OWNER);
  });

  it("re-asserts the org on a delete", async () => {
    const wheres: unknown[] = [];
    const service = new GitConnectionsService(makeDb(wheres));

    await expect(service.deleteConnection(ATTACKER, 1)).rejects.toThrow(NotFoundException);

    const values = wheres.flatMap((clause) => sqlValues(clause));
    expect(values).toContain(ATTACKER);
    expect(values).not.toContain(OWNER);
  });

  it("returns the owning org's own rows (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const service = new GitConnectionsService(makeDb(wheres));

    const page = await service.listConnections(OWNER, { limit: 50 });

    expect(Array.isArray(page.data)).toBe(true);
    expect(wheres.flatMap((clause) => sqlValues(clause))).toContain(OWNER);
  });
});
