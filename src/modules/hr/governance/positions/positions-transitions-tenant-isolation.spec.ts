import { NotFoundException } from "@nestjs/common";
import { PositionsTransitionsService } from "./positions-transitions.service";
import type { Db } from "../../../../db/drizzle.module";

/**
 * Recursively walks a Drizzle SQL AST node and collects every primitive value
 * (string, number, boolean, null) that appears as a query parameter. This is
 * how the cross-tenant isolation tests verify that the orgId the CALLER
 * supplies is the one bound into every SELECT/UPDATE predicate — not the owner's.
 */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value))
    return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value as object)) return [];
  seen.add(value as object);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"])
      ? sqlValues(r["queryChunks"], seen)
      : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

/**
 * Builds a minimal Db double whose SELECT chain captures the `where` predicate.
 * Handles both:
 *   .select().from().where().limit()          (existence checks)
 *   .select().from().where().orderBy().limit() (list queries)
 */
function makeDb(rows: unknown[] = []): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  where.mockReturnValue({ limit, orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("PositionsTransitionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  // ── listTransitions ──────────────────────────────────────────────────────

  describe("listTransitions — predicate isolation", () => {
    it("binds the caller's orgId in the WHERE clause (positive: attacker's org appears)", async () => {
      const { db, where } = makeDb([]);
      const svc = new PositionsTransitionsService(db);

      await svc.listTransitions(ATTACKER);

      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("does not bind the owner's orgId when the attacker calls listTransitions (negative: org-owner absent)", async () => {
      const { db, where } = makeDb([]);
      const svc = new PositionsTransitionsService(db);

      await svc.listTransitions(ATTACKER);

      expect(sqlValues(where.mock.calls[0]?.[0])).not.toContain(OWNER);
    });
  });

  // ── updateTransition — BOLA ──────────────────────────────────────────────

  describe("updateTransition — BOLA: cross-org record is unreachable", () => {
    it(
      "throws NotFoundException (404, not 403) when attacker tries to update a record owned by a different org " +
        "(cross-tenant isolation — BOLA negative test)",
      async () => {
        // Org-scoped SELECT returns no rows: transition id=99 belongs to OWNER,
        // so an ATTACKER-scoped query finds nothing → NotFoundException.
        const { db } = makeDb([]);
        const svc = new PositionsTransitionsService(db);

        await expect(
          svc.updateTransition(ATTACKER, 99, { name: "hijacked" }),
        ).rejects.toThrow(NotFoundException);
      },
    );

    it("scopes the existence check to the caller's orgId, not the owner's (predicate cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new PositionsTransitionsService(db);

      await svc.updateTransition(ATTACKER, 99, { name: "x" }).catch(() => {
        // NotFoundException is expected; we assert the predicate, not the result.
      });

      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
      expect(sqlValues(where.mock.calls[0]?.[0])).not.toContain(OWNER);
    });
  });

  // ── deleteTransition — BOLA ──────────────────────────────────────────────

  describe("deleteTransition — BOLA: cross-org record is unreachable", () => {
    it(
      "throws NotFoundException (404, not 403) when attacker tries to delete a record owned by a different org " +
        "(cross-tenant isolation — BOLA negative test)",
      async () => {
        const { db } = makeDb([]);
        const svc = new PositionsTransitionsService(db);

        await expect(svc.deleteTransition(ATTACKER, 99)).rejects.toThrow(
          NotFoundException,
        );
      },
    );

    it("scopes the existence check to the caller's orgId, not the owner's (predicate cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new PositionsTransitionsService(db);

      await svc.deleteTransition(ATTACKER, 99).catch(() => {});

      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
      expect(sqlValues(where.mock.calls[0]?.[0])).not.toContain(OWNER);
    });
  });
});
