import { BadRequestException } from "@nestjs/common";
import { UNSUPPORTED_SALARY_CURRENCY_MESSAGE } from "./employment-salary-currency";
import { buildService, makeHarness, type Harness } from "./employee-onboarding.spec-fixtures";

const ORG_ID = "org-currency-write";
const ACTOR = { orgId: ORG_ID, userId: "actor-1", isOrgOwner: true };

const BODY = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane.doe@example.com",
  designation: "Engineer",
  whatsappSameAsPhone: true,
  dateOfBirth: "1990-04-01",
  gender: "FEMALE",
  phone: "+919000000000",
  monthlySalary: 50_000,
};

function harnessForCurrency(currency: unknown): Harness {
  return makeHarness({
    findFirst: [null],
    selects: {
      organizations: [[{ currency }]],
      organization_members: [[]],
      salary_components: [[]],
      salary_structure_templates: [[]],
    },
    returning: {
      organization_members: [{ id: 90, userId: "created-1" }],
      employee_salary_profiles: [{ id: 7 }],
    },
  });
}

function sensitiveRow(harness: Harness): Record<string, unknown> | undefined {
  const row = harness.inserted.find(
    (entry) => entry.table === "hr_employee_sensitive_fields",
  );
  return row?.values as Record<string, unknown> | undefined;
}

function salaryProfileRow(harness: Harness): Record<string, unknown> | undefined {
  const row = harness.inserted.find(
    (entry) => entry.table === "employee_salary_profiles",
  );
  return row?.values as Record<string, unknown> | undefined;
}

describe("single employee onboarding writes the organization's currency — P13", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("stamps the salary with the organization's own currency, not INR", async () => {
    const harness = harnessForCurrency("AED");
    const { service } = buildService(harness.db);

    await service.onboardEmployee(ACTOR as never, BODY as never);

    expect(sensitiveRow(harness)).toMatchObject({
      salaryCurrency: "AED",
      salaryFrequency: "MONTHLY",
    });
    expect(salaryProfileRow(harness)).toMatchObject({ currency: "AED" });
  });

  it("keeps INR when INR really is the organization's currency", async () => {
    const harness = harnessForCurrency("INR");
    const { service } = buildService(harness.db);

    await service.onboardEmployee(ACTOR as never, BODY as never);

    expect(sensitiveRow(harness)).toMatchObject({ salaryCurrency: "INR" });
  });

  it("rejects the monetary write instead of substituting INR when the currency is unusable", async () => {
    const harness = harnessForCurrency("");
    const { service } = buildService(harness.db);

    await expect(
      service.onboardEmployee(ACTOR as never, BODY as never),
    ).rejects.toThrow(new BadRequestException(UNSUPPORTED_SALARY_CURRENCY_MESSAGE));
  });

  it("refuses before any row is written when the currency is unusable", async () => {
    const harness = harnessForCurrency(null);
    const { service, ensureFromUser, recordSeatEvents } = buildService(harness.db);

    await expect(
      service.onboardEmployee(ACTOR as never, BODY as never),
    ).rejects.toThrow(BadRequestException);

    expect(harness.inserted).toHaveLength(0);
    expect(ensureFromUser).not.toHaveBeenCalled();
    expect(recordSeatEvents).not.toHaveBeenCalled();
  });

  it("reads no currency at all when the upload carries no salary", async () => {
    const harness = makeHarness({
      findFirst: [null],
      selects: { organization_members: [[]] },
      returning: { organization_members: [{ id: 91, userId: "created-1" }] },
    });
    const { service } = buildService(harness.db);
    const { monthlySalary: _unusedSalary, ...withoutSalary } = BODY;

    await service.onboardEmployee(ACTOR as never, withoutSalary as never);

    expect(sensitiveRow(harness)).toBeUndefined();
    expect(salaryProfileRow(harness)).toBeUndefined();
  });
});
