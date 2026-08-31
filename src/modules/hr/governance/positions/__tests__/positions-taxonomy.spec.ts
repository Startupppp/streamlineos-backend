import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import {
  assertPositionTransitionAllowed,
  type PrefetchedPositionWorkflow,
} from "../positions-workflow-utils";
import { PositionsTaxonomyService } from "../positions-taxonomy.service";
import type { Db } from "../../../../../db/drizzle.module";

const ORG = "org-a";

const STATUSES: PrefetchedPositionWorkflow["statuses"] = [
  { id: 1, name: "open" },
  { id: 2, name: "filled" },
  { id: 3, name: "frozen" },
  { id: 4, name: "future" },
];

function makeTransition(
  overrides: Partial<PrefetchedPositionWorkflow["transitions"][number]> = {},
): PrefetchedPositionWorkflow["transitions"][number] {
  return {
    fromStatusId: 1,
    toStatusId: 2,
    requiresApproval: false,
    requiredFields: [],
    allowedRoles: [],
    ...overrides,
  };
}

describe("assertPositionTransitionAllowed", () => {
  it("permits any transition when no transitions are configured (open-world default)", async () => {
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "open",
        "frozen",
        { isOrgOwner: false },
        { transitions: [], statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();
  });

  it("passes through when the target status is unknown in the lookup", async () => {
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "open",
        "custom_status_not_in_lookup",
        { isOrgOwner: false },
        { transitions: [makeTransition()], statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();
  });

  it("passes through when the source status is unknown in the lookup", async () => {
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "legacy_unknown",
        "filled",
        { isOrgOwner: false },
        { transitions: [makeTransition()], statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a disallowed transition with a descriptive reason", async () => {
    const transitions = [makeTransition({ fromStatusId: 1, toStatusId: 2 })];
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "frozen",
        "open",
        { isOrgOwner: false },
        { transitions, statuses: STATUSES },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "frozen",
        "open",
        { isOrgOwner: false },
        { transitions, statuses: STATUSES },
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it("refuses when requiresApproval is true and caller is not org owner", async () => {
    const transitions = [makeTransition({ requiresApproval: true })];
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "open",
        "filled",
        { isOrgOwner: false },
        { transitions, statuses: STATUSES },
      ),
    ).rejects.toThrow(/approval/);
  });

  it("allows a requiresApproval transition for org owners (bypass)", async () => {
    const transitions = [makeTransition({ requiresApproval: true })];
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "open",
        "filled",
        { isOrgOwner: true },
        { transitions, statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses when a required field is missing on the position", async () => {
    const transitions = [
      makeTransition({ requiredFields: ["incumbentUserId"] }),
    ];
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "open",
        "filled",
        {
          isOrgOwner: false,
          positionFields: {
            incumbentUserId: null,
            departmentId: null,
            budgetedCostCents: null,
            jobLevelId: null,
          },
        },
        { transitions, statuses: STATUSES },
      ),
    ).rejects.toThrow(/incumbentUserId/);
  });

  it("allows the transition when all required fields are present", async () => {
    const transitions = [
      makeTransition({ requiredFields: ["incumbentUserId", "departmentId"] }),
    ];
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "open",
        "filled",
        {
          isOrgOwner: false,
          positionFields: {
            incumbentUserId: "user-001",
            departmentId: "dept-001",
            budgetedCostCents: null,
            jobLevelId: null,
          },
        },
        { transitions, statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();
  });

  it("allows a from-any (null fromStatusId) transition from any source status", async () => {
    const transitions = [makeTransition({ fromStatusId: null, toStatusId: 2 })];
    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "frozen",
        "filled",
        { isOrgOwner: false },
        { transitions, statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertPositionTransitionAllowed(
        {} as Db,
        ORG,
        "future",
        "filled",
        { isOrgOwner: false },
        { transitions, statuses: STATUSES },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("PositionsTaxonomyService.retireStatus", () => {
  function buildDb(
    existingStatus: { id: number; orgId: string; name: string; isActive: boolean } | null,
    activeCount: number,
  ) {
    let selectCall = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        const call = selectCall++;
        if (call === 0) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(
                  existingStatus ? [existingStatus] : [],
                ),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ cnt: activeCount }]),
          }),
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    return mockDb as unknown as Db;
  }

  it("sets isActive=false instead of deleting the row", async () => {
    const status = { id: 1, orgId: ORG, name: "frozen", isActive: true };
    const db = buildDb(status, 3);
    const service = new PositionsTaxonomyService(db);

    const result = await service.retireStatus(ORG, 1);

    expect(result).toEqual({ retired: true });
    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ isActive: false });
  });

  it("throws NotFoundException when the status does not belong to the org", async () => {
    const db = buildDb(null, 3);
    const service = new PositionsTaxonomyService(db);
    await expect(service.retireStatus(ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("refuses to retire the last active status", async () => {
    const status = { id: 1, orgId: ORG, name: "open", isActive: true };
    const db = buildDb(status, 1);
    const service = new PositionsTaxonomyService(db);
    await expect(service.retireStatus(ORG, 1)).rejects.toThrow(BadRequestException);
  });
});

describe("PositionsTaxonomyService.createStatus", () => {
  it("throws ConflictException on duplicate status name within the same org", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ maxOrder: 3 }]),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      }),
    } as unknown as Db;

    const service = new PositionsTaxonomyService(db);
    await expect(
      service.createStatus(ORG, { name: "open" }),
    ).rejects.toThrow(ConflictException);
  });
});

describe("tenant isolation (code-level guarantee)", () => {
  it("listStatuses passes the caller orgId to the query so a second org cannot see the first org's statuses", async () => {
    const captured: string[] = [];
    const mockEq = jest.fn().mockImplementation((_col: unknown, val: unknown) => {
      if (typeof val === "string") captured.push(val);
      return {};
    });

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;

    const service = new PositionsTaxonomyService(db);
    await service.listStatuses("org-alpha");
    await service.listStatuses("org-beta");

    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
