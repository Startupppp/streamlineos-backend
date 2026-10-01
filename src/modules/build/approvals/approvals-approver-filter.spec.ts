import { ApprovalsReadService } from "./approvals-read.service";
import { organizationMembers, projectApprovals, projects } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MANAGER_STANDING, projectAccessRow, standingAccess } from "../core/project-crud/__tests__/project-access-doubles";

const ORG = "org-1";
const PROJECT = 42;
const APPROVER_USER = "user-approver";
const APPROVER_MEMBERSHIP = 77;

const ACTIVE_MEMBERSHIP = {
  id: APPROVER_MEMBERSHIP,
  orgId: ORG,
  userId: APPROVER_USER,
  role: "member",
  isOwner: false,
  status: "ACTIVE",
};

function sqlValues(val: unknown, seen = new Set<object>()): unknown[] {
  if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") return [val];
  if (Array.isArray(val)) return val.flatMap((v) => sqlValues(v, seen));
  if (typeof val !== "object" || seen.has(val as object)) return [];
  seen.add(val as object);
  const rec = val as Record<string, unknown>;
  return [
    ...(rec["queryChunks"] ? sqlValues(rec["queryChunks"], seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec["value"], seen) : []),
  ];
}

function makeDb(memberships: unknown[], whereCalls: unknown[]): Db {
  const builderFor = (table: unknown) => {
    const chain: Record<string, unknown> = {};
    chain["where"] = jest.fn().mockImplementation((cond: unknown) => {
      if (table === projectApprovals) whereCalls.push(cond);
      return chain;
    });
    chain["orderBy"] = jest.fn().mockImplementation(() => chain);
    chain["limit"] = jest
      .fn()
      .mockResolvedValue(
        table === organizationMembers ? memberships : table === projects ? [projectAccessRow()] : [],
      );
    return chain;
  };
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation((table: unknown) => builderFor(table)),
    })),
  } as unknown as Db;
}

const CALLER: CurrentUserContext = {
  orgId: ORG,
  userId: "user-caller",
  role: "owner",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const ACCESS = standingAccess(MANAGER_STANDING) as unknown as AccessService;

describe("listApprovals — filtering by approver", () => {
  it("filters on the approver membership id, because the query carries a user id and the column stores a membership id", async () => {
    const whereCalls: unknown[] = [];
    const svc = new ApprovalsReadService(makeDb([ACTIVE_MEMBERSHIP], whereCalls), ACCESS);

    await svc.listApprovals(CALLER, PROJECT, { approverId: APPROVER_USER });

    const values = whereCalls.flatMap((w) => sqlValues(w));
    expect(values).toContain(APPROVER_MEMBERSHIP);
    expect(values).not.toContain(APPROVER_USER);
  });

  it("matches nothing when the named user is not an active member of this org, rather than returning the project's whole approval list unfiltered", async () => {
    const whereCalls: unknown[] = [];
    const svc = new ApprovalsReadService(makeDb([], whereCalls), ACCESS);

    const page = await svc.listApprovals(CALLER, PROJECT, { approverId: "user-from-another-org" });

    const values = whereCalls.flatMap((w) => sqlValues(w));
    expect(values).toContain("false");
    expect(page.data).toEqual([]);
  });

  it("adds no approver predicate at all when no approver is named, so the pairing above is about the filter and not about every call", async () => {
    const whereCalls: unknown[] = [];
    const svc = new ApprovalsReadService(makeDb([ACTIVE_MEMBERSHIP], whereCalls), ACCESS);

    await svc.listApprovals(CALLER, PROJECT, {});

    const values = whereCalls.flatMap((w) => sqlValues(w));
    expect(values).toContain(ORG);
    expect(values).not.toContain(APPROVER_MEMBERSHIP);
    expect(values).not.toContain("false");
  });
});
