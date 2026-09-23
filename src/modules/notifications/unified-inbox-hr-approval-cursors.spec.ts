jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import { HrTimeApprovalAdapter } from "../hr/time/hr-time-approval.adapter";
import { LeavesService } from "../hr/time/leaves.service";
import { WfhService } from "../hr/time/wfh.service";
import { decodeInboxCursor } from "./dto/unified-inbox.schemas";
import {
  EXPECTED_ORDER,
  FIRST_TRIMMED_ON_PAGE_ONE,
  LAST_DELIVERED_ON_PAGE_ONE,
  MEMBERSHIP,
  ORG,
  OTHER_MEMBERSHIP,
  OTHER_ORG,
  TIED_SEEDS,
  T_C,
  makeInbox,
  orgMemberRows,
  scrollApprovals,
  userRows,
  type Seed,
} from "./approval-cursor.spec-fixtures";

function leaveRows(seeds: Seed[], orgId = ORG, approver = MEMBERSHIP) {
  return seeds.map((seed) => ({
    id: seed.id,
    org_id: orgId,
    user_id: "requester-user",
    leave_type_id: 2,
    start_date: "2026-10-01",
    end_date: "2026-10-03",
    status: "PENDING",
    approver_membership_id: approver,
    user_membership_id: 9,
    created_at: seed.at,
  }));
}

function wfhRows(seeds: Seed[], orgId = ORG, approver = MEMBERSHIP) {
  return seeds.map((seed) => ({
    id: seed.id,
    org_id: orgId,
    user_id: "requester-user",
    date: "2026-10-05",
    reason: null,
    status: "PENDING",
    approver_membership_id: approver,
    user_membership_id: 9,
    created_at: seed.at,
  }));
}

function baseTables(): TableRows {
  return {
    leave_types: [{ id: 2, org_id: ORG, name: "Casual Leave" }],
    users: userRows(),
    organization_members: orgMemberRows(),
  };
}

function makeServices(tables: TableRows) {
  const db = makeFakeDb(tables) as unknown as Db;
  const leaves = new LeavesService(
    db,
    {} as unknown as ConstructorParameters<typeof LeavesService>[1],
    {} as unknown as ConstructorParameters<typeof LeavesService>[2],
    {} as unknown as ConstructorParameters<typeof LeavesService>[3],
    {} as unknown as ConstructorParameters<typeof LeavesService>[4],
  );
  const wfh = new WfhService(
    db,
    {} as unknown as ConstructorParameters<typeof WfhService>[1],
    {} as unknown as ConstructorParameters<typeof WfhService>[2],
    {} as unknown as ConstructorParameters<typeof WfhService>[3],
  );
  const registry = new ApprovalAdapterRegistry();
  new HrTimeApprovalAdapter(leaves, wfh, registry).onModuleInit();
  return { db, registry };
}

function leaveOnly(seeds: Seed[]): TableRows {
  return { ...baseTables(), leave_requests: leaveRows(seeds), wfh_requests: [] };
}

function wfhOnly(seeds: Seed[]): TableRows {
  return { ...baseTables(), leave_requests: [], wfh_requests: wfhRows(seeds) };
}

describe("unified inbox — leave approvals keyset across pages", () => {
  it("delivers every pending leave exactly once across a complete scroll, ties included", async () => {
    const { db, registry } = makeServices(leaveOnly(TIED_SEEDS));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:leave:${String(id)}`));
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("page 2 repeats no row from page 1 and starts at the row immediately after it", async () => {
    const { db, registry } = makeServices(leaveOnly(TIED_SEEDS));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false }, makeUserCtx());
    const second = await svc.list(
      ORG,
      "u",
      { limit: 2, kinds: ["build_approval"], unreadOnly: false, cursor: first.nextCursor ?? undefined },
      makeUserCtx(),
    );

    expect(first.items.map((i) => i.id)).toEqual([50, 30]);
    expect(second.items.map((i) => i.id)).toEqual([10, 40]);
  });

  it("resumes from the last DELIVERED leave, not the last one the over-fetch read", async () => {
    const { db, registry } = makeServices(leaveOnly(TIED_SEEDS));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false }, makeUserCtx());
    const state = decodeInboxCursor(first.nextCursor);

    expect(state.ap["hr:leave"]).toEqual(LAST_DELIVERED_ON_PAGE_ONE);
    expect(state.ap["hr:leave"]?.id).not.toBe(FIRST_TRIMMED_ON_PAGE_ONE);
  });

  it("keeps another approver's and another tenant's rows out of every page", async () => {
    const tables: TableRows = {
      ...baseTables(),
      leave_requests: [
        ...leaveRows(TIED_SEEDS),
        ...leaveRows([{ id: 90, at: TIED_SEEDS[0].at }], ORG, OTHER_MEMBERSHIP),
        ...leaveRows([{ id: 91, at: TIED_SEEDS[0].at }], OTHER_ORG, MEMBERSHIP),
      ],
      wfh_requests: [],
    };
    const { db, registry } = makeServices(tables);

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:leave:${String(id)}`));
    expect(delivered).not.toContain("approval:leave:90");
    expect(delivered).not.toContain("approval:leave:91");
  });
});

describe("unified inbox — wfh approvals keyset across pages", () => {
  it("delivers every pending wfh request exactly once across a complete scroll, ties included", async () => {
    const { db, registry } = makeServices(wfhOnly(TIED_SEEDS));

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 8);

    expect(delivered).toEqual(EXPECTED_ORDER.map((id) => `approval:wfh:${String(id)}`));
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("resumes from the last DELIVERED wfh request, not the last one the over-fetch read", async () => {
    const { db, registry } = makeServices(wfhOnly(TIED_SEEDS));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false }, makeUserCtx());
    const state = decodeInboxCursor(first.nextCursor);

    expect(state.ap["hr:wfh"]).toEqual(LAST_DELIVERED_ON_PAGE_ONE);
    expect(state.ap["hr:wfh"]?.id).not.toBe(FIRST_TRIMMED_ON_PAGE_ONE);
  });
});

describe("unified inbox — two approval adapters sharing one id space", () => {
  it("BITE: delivers all ten rows when leave and wfh carry the same ids at the same timestamps", async () => {
    const tables: TableRows = {
      ...baseTables(),
      leave_requests: leaveRows(TIED_SEEDS),
      wfh_requests: wfhRows(TIED_SEEDS),
    };
    const { db, registry } = makeServices(tables);

    const delivered = await scrollApprovals(makeInbox(db, registry), 2, 20);

    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort()).toEqual(
      [
        ...EXPECTED_ORDER.map((id) => `approval:leave:${String(id)}`),
        ...EXPECTED_ORDER.map((id) => `approval:wfh:${String(id)}`),
      ].sort(),
    );
  });

  it("advances each adapter's position independently", async () => {
    const tables: TableRows = {
      ...baseTables(),
      leave_requests: leaveRows(TIED_SEEDS),
      wfh_requests: wfhRows([{ id: 7, at: T_C }]),
    };
    const { db, registry } = makeServices(tables);
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false }, makeUserCtx());
    const state = decodeInboxCursor(first.nextCursor);

    expect(state.ap["hr:leave"]).toEqual(LAST_DELIVERED_ON_PAGE_ONE);
    expect(state.ap["hr:wfh"]).toBeUndefined();
  });

  it("reports no adapter as cursor-unsupported now that both carry a keyset", async () => {
    const { db, registry } = makeServices(leaveOnly(TIED_SEEDS));
    const svc = makeInbox(db, registry);

    const first = await svc.list(ORG, "u", { limit: 2, kinds: ["build_approval"], unreadOnly: false }, makeUserCtx());
    const second = await svc.list(
      ORG,
      "u",
      { limit: 2, kinds: ["build_approval"], unreadOnly: false, cursor: first.nextCursor ?? undefined },
      makeUserCtx(),
    );
    const source = second.sources.find((s) => s.kind === "build_approval");

    expect(source?.included).toBe(true);
    expect(source?.error ?? "").not.toContain("unsupported: ");
  });
});

function makeUserCtx() {
  return {
    userId: "u",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: MEMBERSHIP, isOrgOwner: false },
  } as unknown as import("../../common/auth/backend-claims").CurrentUserContext;
}
