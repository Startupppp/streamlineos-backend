import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { CareersService } from "./careers.service";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-1";
const JOB_ID = 5;

const mockTxBuilder = (existingCandidate: unknown, existingApplication: unknown) => ({
  query: {
    candidates: { findFirst: jest.fn().mockResolvedValue(existingCandidate) },
    candidateApplications: { findFirst: jest.fn().mockResolvedValue(existingApplication) },
  },
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 42 }]),
    }),
  }),
  execute: jest.fn().mockResolvedValue([]),
});

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

function makeDb(): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ id: JOB_ID, orgId: ORG }]),
        }),
      }),
    }),
  } as unknown as Db;
}

const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };

function makeInput() {
  return {
    jobPostingId: JOB_ID,
    name: "Test User",
    email: "test@example.com",
    phone: undefined,
    linkedinUrl: undefined,
    coverLetter: undefined,
    resumeUrl: undefined,
    answers: {},
  } as Parameters<CareersService["apply"]>[0];
}

describe("CareersService.apply — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows application when quota is not exceeded for a new candidate", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = mockTxBuilder(null, null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);

    const result = await svc.apply(makeInput());

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "hrCandidates", 1, tx);
    expect(result).toMatchObject({ id: 42 });
  });

  it("refuses when quota is exceeded for a new candidate", async () => {
    const assertWithinLimit = jest
      .fn()
      .mockRejectedValue(new PaymentRequiredException({ code: "QUOTA_EXCEEDED", message: "limit" }));
    const tx = mockTxBuilder(null, null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);

    await expect(svc.apply(makeInput())).rejects.toBeInstanceOf(PaymentRequiredException);
  });

  it("skips assertion when the candidate already exists in the org", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = mockTxBuilder({ id: 99 }, null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);

    await svc.apply(makeInput());

    expect(assertWithinLimit).not.toHaveBeenCalled();
  });

  it("returns job_not_found without asserting when the job does not exist", async () => {
    const assertWithinLimit = jest.fn();
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new CareersService(db, cache as never, { assertWithinLimit } as never);

    const result = await svc.apply(makeInput());

    expect(result).toEqual({ error: "job_not_found" });
    expect(assertWithinLimit).not.toHaveBeenCalled();
  });
});
