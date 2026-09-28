import type { Db } from "../../../db/drizzle.module";
import { ApprovalsReadService } from "./approvals-read.service";
import type { AccessService } from "../../access/access.service";

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

function sqlColumns(value: unknown, seen = new Set<object>()): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as {
    queryChunks?: unknown[];
    name?: unknown;
    table?: unknown;
    left?: unknown;
    right?: unknown;
  };
  const here =
    typeof record.name === "string" && record.table !== undefined ? [record.name] : [];
  return [
    ...here,
    ...(record.queryChunks ? record.queryChunks.flatMap((c) => sqlColumns(c, seen)) : []),
    ...sqlColumns(record.left, seen),
    ...sqlColumns(record.right, seen),
  ];
}

const OWNER_ORG = "org-owner";
const MEMBERSHIP_ID = 11;

function serviceCapturingTheJoin() {
  const joinConditions: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.select = passthrough;
  chain.from = passthrough;
  chain.where = passthrough;
  chain.orderBy = passthrough;
  chain.innerJoin = (_table: unknown, condition: unknown) => {
    joinConditions.push(condition);
    return chain;
  };
  chain.limit = () => Promise.resolve([]);

  const db = { select: () => chain } as unknown as Db;
  const access = {} as unknown as AccessService;
  return { service: new ApprovalsReadService(db, access), joinConditions };
}

describe("ApprovalsReadService.getInbox — the projects join is tenant-scoped", () => {
  it("binds the caller's organisation into the projects join, so the join does not rest on projects.id being globally unique", async () => {
    const { service, joinConditions } = serviceCapturingTheJoin();

    await service.getInbox(OWNER_ORG, MEMBERSHIP_ID, {} as never);

    expect(joinConditions).toHaveLength(1);
    expect(sqlValues(joinConditions[0])).toContain(OWNER_ORG);
  });

  it("pairs the tenant column with the id it joins on, which is the composite the project FK already uses", async () => {
    const { service, joinConditions } = serviceCapturingTheJoin();

    await service.getInbox(OWNER_ORG, MEMBERSHIP_ID, {} as never);

    const columns = sqlColumns(joinConditions[0]);
    expect(columns).toContain("org_id");
    expect(columns).toContain("id");
  });

  it("still excludes a soft-deleted project, so a retired parent's approval stays out of the inbox", async () => {
    const { service, joinConditions } = serviceCapturingTheJoin();

    await service.getInbox(OWNER_ORG, MEMBERSHIP_ID, {} as never);

    expect(sqlColumns(joinConditions[0])).toContain("deleted_at");
  });

  it("does not reach a second organisation's value, so the bound list is the caller's org alone", async () => {
    const { service, joinConditions } = serviceCapturingTheJoin();

    await service.getInbox(OWNER_ORG, MEMBERSHIP_ID, {} as never);

    expect(sqlValues(joinConditions[0])).not.toContain("org-other");
  });
});
