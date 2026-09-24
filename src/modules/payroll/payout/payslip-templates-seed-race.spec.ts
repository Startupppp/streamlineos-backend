import { PayslipTemplatesService } from "./payslip-templates.service";

const runInNewTenantTransaction = jest.fn();
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => runInNewTenantTransaction(...args),
}));

interface FakeRow {
  id: number;
  orgId: string;
  name: string;
  layout: string;
  config: unknown;
  isDefault: boolean;
}

function uniqueViolation(constraint: string): Error & { code: string; constraint_name: string } {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: constraint,
  });
}

function fakeDb(existing: FakeRow[]) {
  let call = 0;
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => {
        call += 1;
        return Promise.resolve(call === 1 ? [] : existing);
      }),
    })),
  };
}

const ORG = "org-uuid";

const ALREADY_SEEDED: FakeRow[] = [
  { id: 1, orgId: ORG, name: "Classic Table", layout: "CLASSIC", config: {}, isDefault: true },
  { id: 2, orgId: ORG, name: "Modern Compact", layout: "MODERN", config: {}, isDefault: false },
  { id: 3, orgId: ORG, name: "Detailed Compliance", layout: "COMPLIANCE", config: {}, isDefault: false },
];

describe("PayslipTemplatesService default seeding", () => {
  beforeEach(() => {
    runInNewTenantTransaction.mockReset();
  });

  it("returns the winner's three templates rather than a 500 when a concurrent first read already seeded, because two GETs racing must not surface a unique violation to the caller", async () => {
    runInNewTenantTransaction.mockRejectedValue(
      uniqueViolation("uq_payslip_templates_org_default"),
    );
    const service = new PayslipTemplatesService(fakeDb(ALREADY_SEEDED) as never);

    const page = await service.list(ORG);

    expect(page.data).toHaveLength(3);
    expect(page.data.map((row) => row.layout)).toEqual(["CLASSIC", "MODERN", "COMPLIANCE"]);
  });

  it("seeds exactly one default template, so the loser of the race is the only writer the index rejects", async () => {
    runInNewTenantTransaction.mockResolvedValue(ALREADY_SEEDED);
    const service = new PayslipTemplatesService(fakeDb([]) as never);

    await service.list(ORG);

    const seeded = runInNewTenantTransaction.mock.calls[0]?.[2];
    const tx = { insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) };
    await seeded(tx);
    const values = tx.insert.mock.results[0]?.value.values.mock.calls[0][0] as FakeRow[];
    expect(values.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it("rethrows a unique violation raised by any other constraint, so this rescue cannot swallow an unrelated defect", async () => {
    runInNewTenantTransaction.mockRejectedValue(uniqueViolation("uniq_payslip_templates_org_id"));
    const service = new PayslipTemplatesService(fakeDb(ALREADY_SEEDED) as never);

    await expect(service.list(ORG)).rejects.toMatchObject({ code: "23505" });
  });
});
