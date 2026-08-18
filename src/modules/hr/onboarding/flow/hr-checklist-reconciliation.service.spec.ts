import { Test } from "@nestjs/testing";
import { HrChecklistReconciliationService } from "./hr-checklist-reconciliation.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import {
  documentTypes,
  hiringFlows,
  holidays,
  hrJobRoles,
  hrPositions,
  hrWorkflowDefinitions,
  leavePolicies,
  moduleSetupChecklistItems,
  offerLetterTemplates,
  onboardingTemplates,
  orgHolidays,
  orgUnits,
  organizationMembers,
  payrollPolicies,
  salaryComponents,
  scorecardTemplates,
  shiftTemplates,
} from "../../../../db/schema";

const ORG_ID = "org-1";

type ItemRow = typeof moduleSetupChecklistItems.$inferSelect;

function item(itemKey: string, status: ItemRow["status"]): ItemRow {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    orgId: ORG_ID,
    checklistId: 1,
    itemKey,
    title: itemKey,
    description: null,
    actionHref: null,
    status,
    required: true,
    sortOrder: 0,
    completedAt: null,
    skippedAt: null,
  };
}

describe("HrChecklistReconciliationService", () => {
  let svc: HrChecklistReconciliationService;
  let mockDb: {
    select: jest.Mock;
    update: jest.Mock;
    query: { organizations: { findFirst: jest.Mock } };
  };
  let counts: Map<unknown, number>;
  let updateCalls: Array<{ id: number; set: Record<string, unknown> }>;

  function setCount(table: unknown, value: number) {
    counts.set(table, value);
  }

  const ALL_TABLES = [
    orgUnits,
    hrJobRoles,
    hrPositions,
    leavePolicies,
    holidays,
    orgHolidays,
    shiftTemplates,
    onboardingTemplates,
    documentTypes,
    hrWorkflowDefinitions,
    salaryComponents,
    payrollPolicies,
    hiringFlows,
    scorecardTemplates,
    offerLetterTemplates,
    organizationMembers,
  ];

  beforeEach(async () => {
    jest.resetAllMocks();
    counts = new Map();
    updateCalls = [];
    for (const table of ALL_TABLES) counts.set(table, 0);

    mockDb = {
      select: jest.fn().mockImplementation((selection: unknown) => ({
        from: jest.fn().mockImplementation((table: unknown) => ({
          where: jest.fn().mockImplementation(() => {
            const value = counts.get(table) ?? 0;
            const readsId =
              typeof selection === "object" &&
              selection !== null &&
              Object.hasOwn(selection, "id");
            const rows = readsId ? (value > 0 ? [{ id: value }] : []) : [{ value }];
            const promise = Promise.resolve(rows);
            return {
              limit: jest.fn().mockResolvedValue(rows),
              then: promise.then.bind(promise),
            };
          }),
        })),
      })),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((set: Record<string, unknown>) => ({
          where: jest.fn().mockImplementation(() => {
            updateCalls.push({ id: -1, set });
            return Promise.resolve(undefined);
          }),
        })),
      })),
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: null, country: null, timezone: null }),
        },
      },
    };

    const module = await Test.createTestingModule({
      providers: [HrChecklistReconciliationService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    svc = module.get(HrChecklistReconciliationService);
  });

  it("flips a todo item to done once its backing data exists", async () => {
    setCount(orgHolidays, 1);
    const items = [item("holiday_calendar", "todo")];

    const changed = await svc.reconcile(ORG_ID, items);

    expect(changed).toBe(true);
    expect(updateCalls[0]?.set).toMatchObject({ status: "done" });
  });

  it("leaves a todo item alone when no backing data exists", async () => {
    const items = [item("holiday_calendar", "todo")];

    const changed = await svc.reconcile(ORG_ID, items);

    expect(changed).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it("flips a done item back to todo when its backing data is later removed", async () => {
    setCount(holidays, 0);
    const items = [item("holiday_calendar", "done")];

    const changed = await svc.reconcile(ORG_ID, items);

    expect(changed).toBe(true);
    expect(updateCalls[0]?.set).toMatchObject({ status: "todo" });
  });

  it("never overrides a deliberately skipped item even when data now exists", async () => {
    setCount(hiringFlows, 1);
    const items = [item("recruitment_setup", "skipped")];

    const changed = await svc.reconcile(ORG_ID, items);

    expect(changed).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it("marks locations_departments done when org_units exist", async () => {
    setCount(orgUnits, 0);
    const items = [item("locations_departments", "todo")];

    expect(await svc.reconcile(ORG_ID, items)).toBe(false);

    setCount(orgUnits, 1);
    expect(await svc.reconcile(ORG_ID, items)).toBe(true);
  });

  it("requires BOTH salary components AND an active payroll policy before marking payroll done (AND logic)", async () => {
    setCount(salaryComponents, 1);
    setCount(payrollPolicies, 0);
    const items = [item("payroll_setup", "todo")];

    expect(await svc.reconcile(ORG_ID, items)).toBe(false);

    setCount(payrollPolicies, 1);
    expect(await svc.reconcile(ORG_ID, items)).toBe(true);
  });

  it("marks recruitment setup done if ANY one of hiring flow / scorecard / offer template exists (OR logic)", async () => {
    setCount(scorecardTemplates, 1);
    const items = [item("recruitment_setup", "todo")];

    expect(await svc.reconcile(ORG_ID, items)).toBe(true);
  });

  it("marks org profile done only once name, country, and timezone are all present", async () => {
    mockDb.query.organizations.findFirst.mockResolvedValue({ name: "Acme", country: null, timezone: "Asia/Kolkata" });
    const items = [item("org_profile", "todo")];
    expect(await svc.reconcile(ORG_ID, items)).toBe(false);

    mockDb.query.organizations.findFirst.mockResolvedValue({
      name: "Acme",
      country: "IN",
      timezone: "Asia/Kolkata",
    });
    expect(await svc.reconcile(ORG_ID, items)).toBe(true);
  });

  it("counts every org member except the owner toward the first-employees step", async () => {
    setCount(organizationMembers, 0);
    const items = [item("first_employees", "todo")];
    expect(await svc.reconcile(ORG_ID, items)).toBe(false);

    setCount(organizationMembers, 1);
    expect(await svc.reconcile(ORG_ID, items)).toBe(true);
  });

  it("ignores checklist item keys it doesn't recognize (other modules' items)", async () => {
    const items = [item("import_contacts", "todo")];
    expect(await svc.reconcile(ORG_ID, items)).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});
