jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { NotFoundException } from "@nestjs/common";
import { crmSegments } from "../../../db/schema";
import { sqlValues, tenantDb } from "../../../test/tenant-recorder";
import { REPORTING_REGISTRY } from "../../reporting/compiler/registry";
import { CrmSegmentsService } from "./crm-segments.service";
import { SEGMENT_VIEW } from "./segment-query";

/**
 * Cross-tenant isolation for saved CRM segments and their evaluation.
 *
 * Two surfaces: the saved segment row (read, edit, delete, evaluate by id), and
 * the evaluation itself, where the tenant lives inside the compiled statement.
 * The fixture holds the OWNER's segment; the double answers each statement by
 * the equalities it bound, so a missing org predicate hands the owner's segment
 * — its name and criteria — to the attacker. For evaluation, the executed
 * statement's bound parameters are walked for the caller's org.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const CRITERIA = { kind: "compare", field: "industry", operator: "eq", value: "Textiles" };
const OWNER_SEGMENT = {
  organizationId: OWNER_ORG,
  segmentId: "seg-owner",
  name: "Textile accounts",
  description: null,
  sourceKey: "parties",
  criteria: CRITERIA,
  createdByUserId: "usr-owner",
};

function build() {
  const t = tenantDb({
    fixtures: [{ table: crmSegments, org: crmSegments.organizationId, rows: [OWNER_SEGMENT] }],
  });
  const partiesKey = REPORTING_REGISTRY.get("parties")!.requiredPermission;
  const access = {
    resolveUserPermissions: jest.fn(async () => new Map<string, string>([[SEGMENT_VIEW, "all"], [partiesKey, "all"]])),
  };
  return { t, service: new CrmSegmentsService(t.db, access as never) };
}

const executed = (t: ReturnType<typeof build>["t"]) => t.statements.filter((s) => s.op === "execute");

describe("CrmSegmentsService — cross-tenant isolation", () => {
  it("deny: another org's segment id is a 404", async () => {
    const { t, service } = build();

    await expect(service.getSegment(ATTACKER_ORG, "seg-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(crmSegments, "select")[0], crmSegments.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: evaluating another org's segment executes nothing", async () => {
    const { t, service } = build();

    await expect(service.members(ATTACKER_ORG, "usr-attacker", "seg-owner", 10)).rejects.toBeInstanceOf(NotFoundException);
    expect(executed(t)).toHaveLength(0);
  });

  it("deny: list, edit and delete never reach another org's segment", async () => {
    const { t, service } = build();

    expect(await service.listSegments(ATTACKER_ORG, { limit: 50, offset: 0 } as never)).toEqual([]);
    await expect(service.updateSegment(ATTACKER_ORG, "usr-attacker", "seg-owner", { name: "Mine now" } as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.deleteSegment(ATTACKER_ORG, "seg-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(crmSegments, "select")[0], crmSegments.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmSegments, "update")).toHaveLength(0);
    expect(t.orgBound(t.on(crmSegments, "delete")[0], crmSegments.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: a preview counts inside the caller's org only", async () => {
    const { t, service } = build();

    await service.preview(ATTACKER_ORG, "usr-attacker", { source: "parties", criteria: CRITERIA } as never);

    const [count] = executed(t);
    const bound = sqlValues(count!.args[0]);
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).not.toContain(OWNER_ORG);
  });

  it("control: the owning org evaluates its own segment, and both statements are bound to it", async () => {
    const { t, service } = build();

    const evaluation = await service.members(OWNER_ORG, "usr-owner", "seg-owner", 10);

    expect(evaluation.total).toBe(0);
    expect(executed(t)).toHaveLength(2);
    for (const statement of executed(t)) expect(sqlValues(statement.args[0])).toContain(OWNER_ORG);
  });
});
