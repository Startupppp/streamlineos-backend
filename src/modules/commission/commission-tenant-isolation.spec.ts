jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  crmCommissionAccrualParts,
  crmCommissionAccrualSnapshots,
  crmCommissionAssignments,
  crmCommissionEarnings,
  crmCommissionPlanVersions,
  crmCommissionPlans,
} from "../../db/schema/crm/commission";
import { tenantDb } from "../../test/tenant-recorder";
import { CommissionAccrualService } from "./commission-accrual.service";
import { CommissionService } from "./commission.service";

/**
 * Cross-tenant isolation for the commission plan / earnings ledger and its
 * accrual decomposition.
 *
 * A commission row is somebody's pay, so the reads below are the ones an
 * attacker would aim at: another org's plan by id, its earnings ledger, one
 * earning's derivation, a deal's payout split and the accrual curve. Every
 * fixture holds the OWNER's rows only, and the double answers each statement by
 * the predicates it actually bound — an unscoped read returns the owner's row.
 * So each deny case fails twice over if the org predicate is deleted: the
 * statement binds no org, and the owner's pay reaches the attacker.
 *
 * `runInTenantTransaction` is replaced by a pass-through so the statements
 * inside it are recorded by the same double; the GUC it would set is RLS's
 * backstop, not the predicate under test.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const VIEW_ALL = { userId: "usr-attacker", viewAll: true };

const OWNER_PLAN = { orgId: OWNER_ORG, planId: "plan-owner", name: "Owner AE plan", currency: "USD" };
const OWNER_VERSION = { orgId: OWNER_ORG, planId: "plan-owner", versionNumber: 1, effectiveFrom: "2026-01-01" };
const OWNER_ASSIGNMENT = { orgId: OWNER_ORG, planId: "plan-owner", userId: "rep-owner", effectiveFrom: "2026-01-01" };
const OWNER_EARNING = {
  orgId: OWNER_ORG,
  earningId: "earn-owner",
  userId: "rep-owner",
  planId: "plan-owner",
  status: "CALCULATED",
  amountMinor: 1500,
  earnedOn: "2026-03-10",
};
const OWNER_PART = {
  orgId: OWNER_ORG,
  earningId: "earn-owner",
  sourceType: "deal",
  sourceId: "42",
  userId: "rep-owner",
  planId: "plan-owner",
  partIndex: 0,
  tierIndex: 0,
  tierFrom: 0,
  rateBps: 1000,
  multiplierBps: 10000,
  sliceFromMinor: 0,
  sliceToMinor: 15000,
  basisMinor: 15000,
  amountMinor: 1500,
};
const OWNER_SNAPSHOT = { orgId: OWNER_ORG, userId: "rep-owner", planId: "plan-owner", asOfDate: "2026-03-10", amountMinor: 1500 };

function store() {
  return tenantDb({
    fixtures: [
      { table: crmCommissionPlans, org: crmCommissionPlans.orgId, rows: [OWNER_PLAN] },
      { table: crmCommissionPlanVersions, org: crmCommissionPlanVersions.orgId, rows: [OWNER_VERSION] },
      { table: crmCommissionAssignments, org: crmCommissionAssignments.orgId, rows: [OWNER_ASSIGNMENT] },
      { table: crmCommissionEarnings, org: crmCommissionEarnings.orgId, rows: [OWNER_EARNING] },
      { table: crmCommissionAccrualParts, org: crmCommissionAccrualParts.orgId, rows: [OWNER_PART] },
      { table: crmCommissionAccrualSnapshots, org: crmCommissionAccrualSnapshots.orgId, rows: [OWNER_SNAPSHOT] },
    ],
  });
}

describe("CommissionService — cross-tenant isolation", () => {
  it("deny: listPlans shows the attacker none of another org's plans", async () => {
    const t = store();
    const plans = await new CommissionService(t.db, {} as never).listPlans(ATTACKER_ORG);

    expect(plans).toEqual([]);
    expect(t.orgBound(t.on(crmCommissionPlans, "select")[0], crmCommissionPlans.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: listPlans returns the owning org's plan", async () => {
    const t = store();
    const plans = await new CommissionService(t.db, {} as never).listPlans(OWNER_ORG);

    expect(plans).toEqual([expect.objectContaining({ planId: "plan-owner" })]);
  });

  it("deny: getPlan on another org's plan id is a 404 and reads none of its versions or assignments", async () => {
    const t = store();

    await expect(new CommissionService(t.db, {} as never).getPlan(ATTACKER_ORG, "plan-owner")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.orgBound(t.on(crmCommissionPlans, "select")[0], crmCommissionPlans.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmCommissionPlanVersions)).toHaveLength(0);
    expect(t.on(crmCommissionAssignments)).toHaveLength(0);
  });

  it("control: getPlan returns the owning org's plan with its own versions and assignments", async () => {
    const t = store();
    const result = await new CommissionService(t.db, {} as never).getPlan(OWNER_ORG, "plan-owner");

    expect(result.plan).toMatchObject({ planId: "plan-owner" });
    expect(result.versions).toHaveLength(1);
    expect(result.assignments).toHaveLength(1);
    expect(t.orgBound(t.on(crmCommissionPlanVersions, "select")[0], crmCommissionPlanVersions.orgId)).toEqual([
      OWNER_ORG,
    ]);
    expect(t.orgBound(t.on(crmCommissionAssignments, "select")[0], crmCommissionAssignments.orgId)).toEqual([
      OWNER_ORG,
    ]);
  });

  it("deny: listEarnings for another org's rep returns nothing, even to a view-all viewer", async () => {
    const t = store();
    const earnings = await new CommissionService(t.db, {} as never).listEarnings(
      ATTACKER_ORG,
      { userId: "rep-owner", limit: 50, offset: 0 } as never,
      VIEW_ALL,
    );

    expect(earnings).toEqual([]);
    expect(t.orgBound(t.on(crmCommissionEarnings, "select")[0], crmCommissionEarnings.orgId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("control: listEarnings returns the owning org's earning", async () => {
    const t = store();
    const earnings = await new CommissionService(t.db, {} as never).listEarnings(
      OWNER_ORG,
      { userId: "rep-owner", limit: 50, offset: 0 } as never,
      { userId: "mgr-owner", viewAll: true },
    );

    expect(earnings).toEqual([expect.objectContaining({ earningId: "earn-owner" })]);
  });

  it("deny: approveEarning cannot approve another org's earning", async () => {
    const t = store();

    await expect(
      new CommissionService(t.db, {} as never).approveEarning(ATTACKER_ORG, "earn-owner", "usr-attacker"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(t.orgBound(t.on(crmCommissionEarnings, "update")[0], crmCommissionEarnings.orgId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("control: approveEarning approves the owning org's calculated earning", async () => {
    const t = store();
    const approved = await new CommissionService(t.db, {} as never).approveEarning(OWNER_ORG, "earn-owner", "mgr-owner");

    expect(approved).toMatchObject({ earningId: "earn-owner", status: "APPROVED", approvedBy: "mgr-owner" });
  });
});

describe("CommissionAccrualService — cross-tenant isolation", () => {
  it("deny: decomposeEarning on another org's earning id is a 404 and reads none of its parts", async () => {
    const t = store();

    await expect(
      new CommissionAccrualService(t.db).decomposeEarning(ATTACKER_ORG, "earn-owner", VIEW_ALL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(crmCommissionEarnings, "select")[0], crmCommissionEarnings.orgId)).toEqual([
      ATTACKER_ORG,
    ]);
    expect(t.on(crmCommissionAccrualParts)).toHaveLength(0);
  });

  it("control: decomposeEarning takes apart the owning org's earning, and it reconciles", async () => {
    const t = store();
    const result = await new CommissionAccrualService(t.db).decomposeEarning(OWNER_ORG, "earn-owner", {
      userId: "mgr-owner",
      viewAll: true,
    });

    expect(result.parts).toHaveLength(1);
    expect(result.reconciles).toBe(true);
    expect(t.orgBound(t.on(crmCommissionAccrualParts, "select")[0], crmCommissionAccrualParts.orgId)).toEqual([
      OWNER_ORG,
    ]);
  });

  it("deny: byDeal shows the attacker none of another org's payout split for the same deal id", async () => {
    const t = store();
    const result = await new CommissionAccrualService(t.db).byDeal(ATTACKER_ORG, 42, VIEW_ALL);

    expect(result.parts).toEqual([]);
    expect(result.amountMinor).toBe(0);
    expect(t.orgBound(t.on(crmCommissionAccrualParts, "select")[0], crmCommissionAccrualParts.orgId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("control: byDeal returns the owning org's split for its deal", async () => {
    const t = store();
    const result = await new CommissionAccrualService(t.db).byDeal(OWNER_ORG, 42, {
      userId: "mgr-owner",
      viewAll: true,
    });

    expect(result).toMatchObject({ amountMinor: 1500, partCount: 1, reconciles: true });
  });

  it("deny: curve for another org's rep returns no points", async () => {
    const t = store();
    const result = await new CommissionAccrualService(t.db).curve(
      ATTACKER_ORG,
      { userId: "rep-owner", limit: 100 } as never,
      VIEW_ALL,
    );

    expect(result.points).toEqual([]);
    expect(
      t.orgBound(t.on(crmCommissionAccrualSnapshots, "select")[0], crmCommissionAccrualSnapshots.orgId),
    ).toEqual([ATTACKER_ORG]);
  });

  it("control: curve returns the owning org's rep's points", async () => {
    const t = store();
    const result = await new CommissionAccrualService(t.db).curve(
      OWNER_ORG,
      { userId: "rep-owner", limit: 100 } as never,
      { userId: "mgr-owner", viewAll: true },
    );

    expect(result.points).toEqual([expect.objectContaining({ asOfDate: "2026-03-10" })]);
  });
});
