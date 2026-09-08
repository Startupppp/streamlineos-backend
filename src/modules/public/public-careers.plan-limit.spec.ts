import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { PublicCareersService } from "./public-careers.service";
import type { Db } from "../../db/drizzle.module";

const ORG_SLUG = "acme";
const ORG = "org-1";
const JOB_ID = 9;

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

function makeDb(): Db {
  return {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ id: ORG, name: "Acme" }),
      },
      jobPostings: {
        findFirst: jest.fn().mockResolvedValue({ id: JOB_ID, title: "Engineer" }),
      },
    },
  } as unknown as Db;
}

function makeTx(existingByEmail: unknown) {
  const selectLimit = jest.fn().mockResolvedValue(existingByEmail ? [existingByEmail] : []);
  const selectWhere = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const select = jest.fn().mockReturnValue({ from: selectFrom });

  const racedLimit = jest.fn().mockResolvedValue([]);
  const racedWhere = jest.fn().mockReturnValue({ limit: racedLimit });
  const racedFrom = jest.fn().mockReturnValue({ where: racedWhere });

  return {
    select: jest.fn()
      .mockReturnValueOnce({ from: selectFrom })
      .mockReturnValue({ from: racedFrom }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    _selectLimit: selectLimit,
    _select: select,
  };
}

function makeInput() {
  return {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: undefined,
    linkedinUrl: undefined,
    coverLetter: undefined,
    resumeUrl: undefined,
  } as Parameters<PublicCareersService["applyToOrgJob"]>[2];
}

describe("PublicCareersService.applyToOrgJob — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows application and asserts quota for a new candidate", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx(null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);

    const result = await svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput());

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "hrCandidates", 1, tx);
    expect(result).toHaveProperty("trackingToken");
  });

  it("refuses when quota is exceeded for a new candidate", async () => {
    const assertWithinLimit = jest
      .fn()
      .mockRejectedValue(new PaymentRequiredException({ code: "QUOTA_EXCEEDED", message: "limit" }));
    const tx = makeTx(null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);

    await expect(svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput())).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
  });

  it("skips assertion when the candidate email already exists in the org", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx({ id: 77 });
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);

    await svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput());

    expect(assertWithinLimit).not.toHaveBeenCalled();
  });
});
