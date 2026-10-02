import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTemplatesService } from "./projects-templates.service";
import type { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { BuildTicketCreationService } from "../tickets";

function hasOwnPropStr<K extends string>(obj: object, key: K): obj is Record<K, unknown> {
  return key in obj;
}

function collectParamValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (node === null || node === undefined) return acc;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    acc.push(node);
    return acc;
  }
  if (typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectParamValues(item, acc);
    return acc;
  }
  if (hasOwnPropStr(node, "encoder") && hasOwnPropStr(node, "value")) {
    acc.push(node.value);
    return acc;
  }
  if (hasOwnPropStr(node, "queryChunks")) {
    const qc = node.queryChunks;
    if (Array.isArray(qc)) {
      for (const chunk of qc) collectParamValues(chunk, acc);
    }
  }
  return acc;
}

interface Captured {
  where: unknown;
}

function makeDb(captured: Captured): Db {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

const mockPlanLimits = {} as PlanLimitsService;
const mockAudit = {} as AuditService;
const mockTicketCreation = {} as BuildTicketCreationService;

const ORG = "org-templates-search";

describe("ProjectsTemplatesService.listTemplates — full-text search predicate (BE-49, BE-80)", () => {
  it("includes the search term as a WHERE param using to_tsvector/plainto_tsquery so the DB filters rather than the caller", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ProjectsTemplatesService(makeDb(captured), mockPlanLimits, mockAudit, mockTicketCreation);
    await svc.listTemplates(ORG, { q: "agile-retrospective" });
    const params = collectParamValues(captured.where);
    expect(params).toContain("agile-retrospective");
  });

  it("keeps orgId in WHERE alongside the search term so templates from another org cannot be returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ProjectsTemplatesService(makeDb(captured), mockPlanLimits, mockAudit, mockTicketCreation);
    await svc.listTemplates(ORG, { q: "agile-retrospective" });
    const params = collectParamValues(captured.where);
    expect(params).toContain("agile-retrospective");
    expect(params).toContain(ORG);
  });

  it("omits the search predicate when no q is given so all org templates are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ProjectsTemplatesService(makeDb(captured), mockPlanLimits, mockAudit, mockTicketCreation);
    await svc.listTemplates(ORG, {});
    const params = collectParamValues(captured.where);
    expect(params).not.toContain("agile-retrospective");
    expect(params).toContain(ORG);
  });
});
