import { seedSystemRolesForOrg } from "../seed-system-roles";
import { MODULE_CATALOG } from "../../../common/rbac/module-vocabulary";
import { ACCESS_MANAGED_MODULES } from "../permissions";

const ORG_ID = "org-seed-test";
const EXPECTED_SYSTEM_ROLE_COUNT =
  1 +
  MODULE_CATALOG.length +
  ACCESS_MANAGED_MODULES.length * 2;

function makeInsertChain(returningValue: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);
  chain.onConflictDoUpdate = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue(returningValue);
  return chain;
}

function makeSelectChain(resolveValue: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(resolveValue);
  return chain;
}

function buildDb(rolesInsertReturning: unknown[]) {
  const txInsert = jest.fn().mockImplementation(() => makeInsertChain(rolesInsertReturning));
  const txMock = { insert: txInsert };
  const db = {
    select: jest.fn().mockReturnValue(makeSelectChain([])),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    ),
  };
  return { db, txInsert };
}

describe("seedSystemRolesForOrg", () => {
  it("creates all expected system roles for a fresh org", async () => {
    const { db } = buildDb([{ id: 42 }]);

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(EXPECTED_SYSTEM_ROLE_COUNT);
  });

  it("is idempotent — a second run creates nothing new", async () => {
    const { db, txInsert } = buildDb([]);

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(0);
    expect(txInsert).toHaveBeenCalledTimes(EXPECTED_SYSTEM_ROLE_COUNT);
  });

  it("does not insert grants when the role already exists", async () => {
    const txInsert = jest.fn().mockImplementation(() => makeInsertChain([]));
    const txMock = { insert: txInsert };
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ name: "hr:employees:view" }])),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(txInsert).toHaveBeenCalledTimes(EXPECTED_SYSTEM_ROLE_COUNT);
  });
});
