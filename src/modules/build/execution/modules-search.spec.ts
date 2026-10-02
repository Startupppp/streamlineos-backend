import type { Db } from "../../../db/drizzle.module";
import { ModulesService } from "./modules.service";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("../core/project-crud/project-access", () => ({
  ...jest.requireActual<typeof import("../core/project-crud/project-access")>("../core/project-crud/project-access"),
  assertProjectVisible: jest.fn().mockResolvedValue(undefined),
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
  assertProjectWriteAccess: jest.fn().mockResolvedValue(undefined),
  assertCanManageProject: jest.fn().mockResolvedValue(undefined),
}));

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

function makeDb() {
  const capturedWhereConds: unknown[] = [];
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capturedWhereConds.push(cond);
    return { orderBy };
  });
  const groupBy = jest.fn().mockResolvedValue([]);
  const fromStats = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy }) });
  let callCount = 0;
  const from = jest.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) return { where };
    return { where: jest.fn().mockReturnValue({ groupBy }) };
  });
  const select = jest.fn().mockReturnValue({ from });
  const db = {
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
    select,
  } as unknown as Db;
  return { db, capturedWhereConds };
}

const ORG = "org-abc";
const ACTOR: CurrentUserContext = {
  userId: "u-owner",
  orgId: ORG,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

describe("ModulesService — server-side search predicate (B10)", () => {
  it("with search term — WHERE carries the trimmed term so a page 2 match is not missed by client filter (BE-134 failing first)", async () => {
    const { db, capturedWhereConds } = makeDb();
    const svc = new ModulesService(db, stubService<AccessService>({}));

    await svc.listModules(ACTOR, 1, { search: "auth" });

    const allValues = capturedWhereConds.flatMap((c) => sqlValues(c));
    expect(allValues.some((v) => typeof v === "string" && v.includes("auth"))).toBe(true);
  });

  it("without search term — WHERE does not carry a name-match literal so no rows are pre-filtered (BE-141 positive control)", async () => {
    const { db, capturedWhereConds } = makeDb();
    const svc = new ModulesService(db, stubService<AccessService>({}));

    await svc.listModules(ACTOR, 1);

    const allValues = capturedWhereConds.flatMap((c) => sqlValues(c));
    expect(allValues.every((v) => typeof v !== "string" || !v.endsWith("%"))).toBe(true);
  });
});
