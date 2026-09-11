import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
import type { Db } from "../../../db/drizzle.module";

const stub = <T,>() => ({}) as T;

function makeDb(overrides: Partial<Db> = {}): Db {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing, returning });
  return {
    selectDistinct: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values }),
    query: { candidates: { findMany: jest.fn().mockResolvedValue([]) } },
    ...overrides,
  } as unknown as Db;
}

const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };

function makeSvc(planLimits: { assertWithinLimit: jest.Mock }) {
  const db = makeDb();
  return {
    svc: new RecruitmentCandidateOpsService(
      db,
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[1]>(),
      cache as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[2],
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[3]>(),
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[4]>(),
      planLimits as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[5],
    ),
    db,
  };
}

function bulkImportInput(emails: string[]) {
  return {
    rows: emails.map((email, i) => ({
      firstName: `First${i}`,
      lastName: `Last${i}`,
      email,
    })),
  } as Parameters<RecruitmentCandidateOpsService["bulkImport"]>[1];
}

function importInput(emails: string[]) {
  return {
    candidates: emails.map((email, i) => ({
      firstName: `First${i}`,
      lastName: `Last${i}`,
      email,
    })),
  } as Parameters<RecruitmentCandidateOpsService["importCandidates"]>[1];
}

describe("RecruitmentCandidateOpsService.bulkImport — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows import when quota is not exceeded", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ assertWithinLimit });

    const result = await svc.bulkImport("org-1", bulkImportInput(["a@x.com", "b@x.com"]));

    expect(result.created).toBe(2);
    expect(assertWithinLimit).toHaveBeenCalledWith("org-1", "hrCandidates", 2);
  });

  it("refuses import when quota is exceeded", async () => {
    const assertWithinLimit = jest
      .fn()
      .mockRejectedValue(new PaymentRequiredException({ code: "QUOTA_EXCEEDED", message: "limit" }));
    const { svc } = makeSvc({ assertWithinLimit });

    await expect(svc.bulkImport("org-1", bulkImportInput(["a@x.com"]))).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
  });

  it("skips assertion when all rows are duplicates (no new candidates to insert)", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const db = {
      selectDistinct: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockReturnValue({ limit: jest.fn().mockResolvedValue([{ email: "existing@x.com" }]) }),
        }),
      }),
      insert: jest.fn(),
      query: { candidates: { findMany: jest.fn().mockResolvedValue([]) } },
    } as unknown as Db;
    const svc = new RecruitmentCandidateOpsService(
      db,
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[1]>(),
      cache as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[2],
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[3]>(),
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[4]>(),
      { assertWithinLimit } as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[5],
    );

    const result = await svc.bulkImport("org-1", bulkImportInput(["existing@x.com"]));

    expect(result.skipped).toBe(1);
    expect(assertWithinLimit).not.toHaveBeenCalled();
  });

  it("asserts for only the net-new count when some rows are duplicates", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const db = {
      selectDistinct: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockReturnValue({ limit: jest.fn().mockResolvedValue([{ email: "existing@x.com" }]) }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
      }),
      query: { candidates: { findMany: jest.fn().mockResolvedValue([]) } },
    } as unknown as Db;
    const svc = new RecruitmentCandidateOpsService(
      db,
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[1]>(),
      cache as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[2],
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[3]>(),
      stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[4]>(),
      { assertWithinLimit } as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[5],
    );

    await svc.bulkImport("org-1", bulkImportInput(["existing@x.com", "new@x.com"]));

    expect(assertWithinLimit).toHaveBeenCalledWith("org-1", "hrCandidates", 1);
  });
});

describe("RecruitmentCandidateOpsService.importCandidates — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows import when quota is not exceeded", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ assertWithinLimit });

    const result = await svc.importCandidates("org-1", importInput(["a@x.com", "b@x.com"]));

    expect(result.imported).toBe(1);
    expect(assertWithinLimit).toHaveBeenCalledWith("org-1", "hrCandidates", 2);
  });

  it("refuses import when quota is exceeded", async () => {
    const assertWithinLimit = jest
      .fn()
      .mockRejectedValue(new PaymentRequiredException({ code: "QUOTA_EXCEEDED", message: "limit" }));
    const { svc } = makeSvc({ assertWithinLimit });

    await expect(
      svc.importCandidates("org-1", importInput(["a@x.com"])),
    ).rejects.toBeInstanceOf(PaymentRequiredException);
  });

  it("asserts for the full candidate count regardless of duplicates", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ assertWithinLimit });

    await svc.importCandidates("org-1", importInput(["a@x.com", "b@x.com", "c@x.com"]));

    expect(assertWithinLimit).toHaveBeenCalledWith("org-1", "hrCandidates", 3);
  });
});
