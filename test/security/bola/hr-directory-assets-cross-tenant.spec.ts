/**
 * BOLA — cross-tenant isolation for HR directory `AssetsService`.
 *
 * ## Why this lives here and not beside the service
 *
 * `check:tenant-isolation` names `src/modules/hr/directory/assets.service.ts` as
 * a tenant-owned service with no cross-tenant negative test. Its twelve sibling
 * services in that folder are covered by `directory-tenant-isolation.spec.ts`;
 * `AssetsService` was left out of that file, and the only spec that names it —
 * `assets.service.spec.ts` — is about the terminal-status guard on a return
 * record and never mentions tenancy.
 *
 * `src/modules/hr/` is fenced off from this branch: it belongs to the HR
 * developer and this branch may not edit files inside it, which rules out both
 * the obvious homes for this test. `test/security/bola/` is where cross-tenant
 * object-level tests already live, it is a jest root, and it is outside the
 * fence — so the missing coverage can be written without touching HR's tree. If
 * the owner later folds these cases into `directory-tenant-isolation.spec.ts`,
 * this file should be deleted rather than kept beside it.
 *
 * Known cost of the location: `test/security/**` is run by jest but NOT
 * typechecked (backend/CLAUDE.md §8), so a change to `AssetsService`'s
 * constructor arity would break this file invisibly to `tsc`. The constructor
 * takes one argument, the Drizzle handle, which keeps that exposure small.
 *
 * ## The two halves
 *
 * DENY is the behaviour: with the owning tenant's rows invisible to the caller,
 * every id-taking method must raise `NotFoundException` — 404, never 403,
 * because a 403 on another org's id confirms the record exists
 * (backend/CLAUDE.md §4) — and must not fall through to a write.
 *
 * CONTROL is the mechanism: it reads back the predicate the service handed
 * Drizzle and asserts the caller's `orgId` is bound into it. Without this half a
 * service that had dropped `eq(orgId)` altogether would still pass every DENY
 * case, because a double that answers nothing answers nothing for every reason.
 */

import { NotFoundException } from "@nestjs/common";
import { AssetsService } from "../../../src/modules/hr/directory/assets.service";

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

/** Every bound value in a Drizzle expression tree, flattened. */
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
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type Chain = {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  orderBy: jest.Mock;
  leftJoin: jest.Mock;
  innerJoin: jest.Mock;
  set: jest.Mock;
  values: jest.Mock;
  returning: jest.Mock;
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
};

/** A Drizzle-shaped builder that is also a thenable: `await` anywhere gives `rows`. */
function makeChain(rows: unknown[]): Chain {
  const chain = {} as Chain;
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  for (const method of [
    "from",
    "where",
    "limit",
    "orderBy",
    "leftJoin",
    "innerJoin",
    "set",
    "values",
    "returning",
  ] as const)
    chain[method] = jest.fn().mockReturnValue(chain);
  return chain;
}

type Harness = {
  service: AssetsService;
  select: Chain;
  findFirst: jest.Mock;
  writes: { update: number; delete: number };
};

/**
 * @param rows  what a `select(...)` chain resolves to.
 * @param found what `query.employeeDevices.findFirst` answers — `undefined`
 *              models the foreign tenant, whose rows this caller cannot see.
 */
function harness(rows: unknown[] = [], found: unknown = undefined): Harness {
  const select = makeChain(rows);
  const findFirst = jest.fn().mockResolvedValue(found);
  const writes = { update: 0, delete: 0 };

  const updateChain = makeChain([]);
  const deleteChain = makeChain([]);

  const db = {
    select: jest.fn().mockReturnValue(select),
    update: jest.fn(() => {
      writes.update += 1;
      return updateChain;
    }),
    delete: jest.fn(() => {
      writes.delete += 1;
      return deleteChain;
    }),
    insert: jest.fn().mockReturnValue(makeChain([])),
    query: { employeeDevices: { findFirst }, assetReturns: { findFirst } },
  };

  return { service: new AssetsService(db as never), select, findFirst, writes };
}

describe("AssetsService — cross-tenant isolation (BOLA)", () => {
  describe("asset returns", () => {
    it("404s on another org's return record and writes nothing (DENY — cross-tenant isolation)", async () => {
      const { service, writes } = harness([]);

      await expect(
        service.updateAssetReturn(ATTACKER, 1, { status: "RETURNED" } as never),
      ).rejects.toBeInstanceOf(NotFoundException);

      // The refusal must land before the UPDATE. An update scoped only by id
      // would finalize another tenant's return record on the way to the 404.
      expect(writes.update).toBe(0);
    });

    it("binds the caller's org into the return lookup (CONTROL)", async () => {
      const { service, select } = harness([{ id: 1, orgId: OWNER, status: "PENDING", condition: null, notes: null }]);

      await service
        .updateAssetReturn(OWNER, 1, { status: "RETURNED" } as never)
        .catch(() => undefined);

      expect(select.where).toHaveBeenCalled();
      expect(sqlValues(select.where.mock.calls[0]?.[0])).toContain(OWNER);
    });
  });

  describe("employee devices", () => {
    it("404s on another org's device id from updateDevice and writes nothing (DENY — cross-tenant isolation)", async () => {
      const { service, writes } = harness([], undefined);

      await expect(
        service.updateDevice(ATTACKER, 5, { deviceName: "renamed" } as never),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(writes.update).toBe(0);
    });

    it("404s on another org's device id from deleteDevice and deletes nothing (DENY — cross-tenant isolation)", async () => {
      const { service, writes } = harness([], undefined);

      await expect(service.deleteDevice(ATTACKER, 5)).rejects.toBeInstanceOf(NotFoundException);

      // A hard DELETE scoped only by id is unrecoverable, so this is the one
      // case where the missing predicate would destroy rather than disclose.
      expect(writes.delete).toBe(0);
    });

    it("binds the caller's org into the device lookup (CONTROL)", async () => {
      const { service, findFirst } = harness([], { id: 5 });

      await service.updateDevice(OWNER, 5, { deviceName: "renamed" } as never).catch(() => undefined);

      expect(findFirst).toHaveBeenCalled();
      const where = (findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
      expect(sqlValues(where)).toContain(OWNER);
    });

    it("scopes the device list to the requesting org (CONTROL)", async () => {
      const { service, select } = harness([]);

      const rows = await service.listDevices(ATTACKER);

      expect(rows).toHaveLength(0);
      expect(select.where).toHaveBeenCalled();
      expect(sqlValues(select.where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });
  });
});
