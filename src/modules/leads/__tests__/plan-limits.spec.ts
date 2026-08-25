import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { LeadsService } from "../leads.service";
import { LeadsReadService } from "../leads-read.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { CrmValidationService } from "../../crm/metadata/crm-validation.service";
import { CrmAutomationBusService } from "../../crm/automation-studio/crm-automation-bus.service";
import { CrmAttributionReportService } from "../../crm/core/crm-attribution-report.service";
import { TerritoryMatchService } from "../../crm/core/territory-match.service";
import { LeadsBoardService } from "../leads-board.service";
import { createMirroredLead } from "../../party/party-legacy-leads";

/**
 * The write is stubbed at the mirror seam, which is where it now begins.
 *
 * A lead is a party row written first and a `leads` row derived from it, so
 * "did the create reach the database" is no longer "was `db.insert` called" --
 * it is "did it reach the writer". What this file is about is unchanged: the
 * plan limit is checked before anything is written at all.
 */
jest.mock("../../party/party-legacy-leads", () => ({
  createMirroredLead: jest.fn().mockResolvedValue({
    id: 1,
    name: "Test Lead",
    source: "direct",
    priority: "WARM",
    orgId: "org-limits-test",
    assignedToId: null,
  }),
  softDeleteMirroredLeads: jest.fn().mockResolvedValue([]),
  updateMirroredLead: jest.fn().mockResolvedValue(undefined),
}));

const mirrorCreate = createMirroredLead as unknown as jest.Mock;

const ORG = "org-limits-test";
const USER = "user-1";

const makeMockPlanLimits = (shouldDeny = false): jest.Mocked<Pick<PlanLimitsService, "assertWithinLimit">> => ({
  assertWithinLimit: jest.fn().mockImplementation(() => {
    if (shouldDeny) throw new ForbiddenException("Your FREE plan allows 100 leads. Upgrade your plan to add more.");
    return Promise.resolve();
  }),
});

const makeDb = () => {
  const chain: Record<string, jest.Mock> = {};
  const end = jest.fn().mockResolvedValue([]);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([{ id: 1, name: "Test Lead", source: "direct", priority: "WARM", orgId: ORG, assignedToId: null }]);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  // The after-effects of a create read the lead back through the Party seam,
  // which joins the map to `business_parties`.
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue([]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.delete = jest.fn().mockReturnValue(chain);
  chain._end = end;
  return chain;
};

describe("LeadsService plan-limit enforcement", () => {
  let svc: LeadsService;

  const buildModule = async (db: Record<string, jest.Mock>, planLimitsMock: Pick<PlanLimitsService, "assertWithinLimit">) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: DRIZZLE, useValue: { ...db, query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) } } } },
        { provide: PlanLimitsService, useValue: planLimitsMock },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: EmailService, useValue: { sendLeadAssignedEmail: jest.fn() } },
        { provide: AutomationService, useValue: { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: WebhooksDispatchService, useValue: { dispatch: jest.fn() } },
        { provide: CrmValidationService, useValue: { evaluate: jest.fn().mockResolvedValue({ valid: true, errors: [] }) } },
        { provide: CrmAutomationBusService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: CrmAttributionReportService, useValue: { recordTouch: jest.fn().mockResolvedValue(undefined) } },
        { provide: TerritoryMatchService, useValue: {} },
        { provide: LeadsBoardService, useValue: { getBoard: jest.fn(), getStats: jest.fn() } },
        { provide: LeadsReadService, useValue: { listLeads: jest.fn(), getBoard: jest.fn(), getStats: jest.fn(), getLead: jest.fn() } },
      ],
    }).compile();

    return module.get(LeadsService);
  };

  beforeEach(() => {
    mirrorCreate.mockClear();
  });

  it("throws ForbiddenException when plan limit is exceeded on create", async () => {
    const db = makeDb();
    const planLimits = makeMockPlanLimits(true);
    svc = await buildModule(db, planLimits);

    await expect(
      svc.create(ORG, USER, { name: "Test", source: "direct", priority: "WARM" }),
    ).rejects.toThrow(ForbiddenException);

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(ORG, "crmLeads");
    expect(mirrorCreate).not.toHaveBeenCalled();
  });

  it("does not call insert when plan limit throws before validation", async () => {
    const db = makeDb();
    const planLimits = makeMockPlanLimits(true);
    svc = await buildModule(db, planLimits);

    await expect(
      svc.create(ORG, USER, { name: "Test Lead", source: "direct", priority: "WARM" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(mirrorCreate).not.toHaveBeenCalled();
  });

  it("proceeds past limit check when within limit", async () => {
    const db = makeDb();
    const planLimits = makeMockPlanLimits(false);
    svc = await buildModule(db, planLimits);

    await svc.create(ORG, USER, { name: "Test Lead", source: "direct", priority: "WARM" });

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(ORG, "crmLeads");
    expect(mirrorCreate).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      expect.objectContaining({ orgId: ORG, name: "Test Lead" }),
    );
  });
});
