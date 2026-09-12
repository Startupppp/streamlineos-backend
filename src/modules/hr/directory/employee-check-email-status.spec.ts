import type { Db } from "../../../db/drizzle.module";
import { checkEmailSchema } from "./dto/directory-response.schemas";
import { EmployeesService } from "./employees.service";

const ORG_ID = "org-check";
const USER_ID = "user-check-1";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record["queryChunks"]) ? sqlValues(record["queryChunks"], seen) : []),
    ...("value" in record ? sqlValues(record["value"], seen) : []),
  ];
}

interface Script {
  account?: { id: string } | null;
  member?: { status: string } | null;
  employment?: unknown[];
}

interface Harness {
  service: EmployeesService;
  usersFindFirst: jest.Mock;
  memberFindFirst: jest.Mock;
  employmentSelect: jest.Mock;
}

function makeHarness(script: Script): Harness {
  const usersFindFirst = jest.fn().mockResolvedValue(script.account ?? null);
  const memberFindFirst = jest.fn().mockResolvedValue(script.member ?? null);
  const employmentSelect = jest.fn(() => ({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(script.employment ?? []),
        }),
      }),
    }),
  }));

  const db = {
    query: {
      users: { findFirst: usersFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
    },
    select: employmentSelect,
  } as unknown as Db;

  const service = new EmployeesService(
    db,
    { cachedVersioned: jest.fn() } as never,
    { getFactsBatch: jest.fn() } as never,
  );

  return { service, usersFindFirst, memberFindFirst, employmentSelect };
}

describe("EmployeesService.checkEmail — P4 discriminated admission outcome", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("reports an unknown address as available and never looks for employment", async () => {
    const harness = makeHarness({ account: null });

    await expect(harness.service.checkEmail(ORG_ID, "New.Person@Example.com")).resolves.toEqual({
      exists: false,
      status: "available",
      memberStatus: null,
    });
    expect(harness.employmentSelect).not.toHaveBeenCalled();
  });

  it("canonicalises the address before the lookup", async () => {
    const harness = makeHarness({ account: null });

    await harness.service.checkEmail(ORG_ID, "  New.Person@EXAMPLE.com  ");

    const bound = sqlValues(
      (harness.usersFindFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"],
    );
    expect(bound).toContain("new.person@example.com");
  });

  it("does not disclose an account that belongs to no member of this organization", async () => {
    const harness = makeHarness({ account: { id: USER_ID }, member: null });

    await expect(harness.service.checkEmail(ORG_ID, "someone@example.com")).resolves.toEqual({
      exists: false,
      status: "available",
      memberStatus: null,
    });
  });

  it("distinguishes a member who holds no employment from an employee", async () => {
    const harness = makeHarness({
      account: { id: USER_ID },
      member: { status: "ACTIVE" },
      employment: [],
    });

    await expect(harness.service.checkEmail(ORG_ID, "teammate@example.com")).resolves.toEqual({
      exists: true,
      status: "member-without-employment",
      memberStatus: null,
    });
  });

  it("reports a member who already holds a live primary employment as an employee", async () => {
    const harness = makeHarness({
      account: { id: USER_ID },
      member: { status: "ACTIVE" },
      employment: [{ employmentId: 11 }],
    });

    await expect(harness.service.checkEmail(ORG_ID, "employee@example.com")).resolves.toEqual({
      exists: true,
      status: "employee",
      memberStatus: null,
    });
  });

  it.each(["SUSPENDED", "LEFT"])(
    "reports a %s membership as archived and never reads employment",
    async (status) => {
      const harness = makeHarness({
        account: { id: USER_ID },
        member: { status },
      });

      await expect(harness.service.checkEmail(ORG_ID, "archived@example.com")).resolves.toEqual({
        exists: true,
        status: "archived-member",
        memberStatus: status,
      });
      expect(harness.employmentSelect).not.toHaveBeenCalled();
    },
  );

  it("returns a shape the published response contract accepts", async () => {
    const harness = makeHarness({
      account: { id: USER_ID },
      member: { status: "ACTIVE" },
      employment: [],
    });

    const result = await harness.service.checkEmail(ORG_ID, "teammate@example.com");

    expect(checkEmailSchema.safeParse(result).success).toBe(true);
  });
});
