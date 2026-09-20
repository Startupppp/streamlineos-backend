import { desc } from "drizzle-orm";
import { PeriodsReadService } from "../periods-read.service";
import type { Db } from "../../../../db/drizzle.types";
import type { AccessService } from "../../../access/access.service";
import { periodDetailResponseSchema } from "../dto/timesheets-periods-response.schemas";

type FindManyArgs = {
  columns?: Record<string, boolean>;
  with?: Record<string, unknown>;
  limit?: number;
  orderBy?: unknown;
};

function makeReader(capture: { args?: FindManyArgs }) {
  const db = {
    query: {
      timesheets: {
        findMany: jest.fn((args: FindManyArgs) => {
          capture.args = args;
          return Promise.resolve([]);
        }),
      },
    },
  };
  return new PeriodsReadService(
    db as unknown as Db,
    {} as unknown as AccessService,
  );
}

describe("a period's entries carry the project the screen renders", () => {
  it("asks for the project relation, so the client contract's non-optional project field is satisfied", async () => {
    const capture: { args?: FindManyArgs } = {};
    const reader = makeReader(capture);

    await reader.listPeriodEntries("org-1", 42);

    expect(capture.args?.with).toHaveProperty("project");
    expect(capture.args?.with?.project).toEqual({ columns: { id: true, name: true } });
  });

  it("projects explicit columns and bounds the read instead of selecting the whole row", async () => {
    const capture: { args?: FindManyArgs } = {};
    const reader = makeReader(capture);

    await reader.listPeriodEntries("org-1", 42);

    expect(capture.args?.columns).toBeDefined();
    expect(capture.args?.columns).not.toHaveProperty("imageUrl");
    expect(capture.args?.columns).not.toHaveProperty("costRate");
    expect(typeof capture.args?.limit).toBe("number");
    expect(capture.args?.orderBy).toEqual([desc(expect.anything())]);
  });

  it("declares project in the response schema, so the contract gate can catch this drift next time", () => {
    const entry = {
      id: 1,
      orgId: "org-1",
      userMembershipId: 2,
      ticketId: null,
      projectId: 7,
      date: "2026-09-18",
      hours: "2.00",
      description: null,
      isBillable: true,
      billingType: "BILLABLE",
      status: "PENDING",
      submittedAt: null,
      approvedAt: null,
      approvedByMembershipId: null,
      rejectionReason: null,
      voidedAt: null,
      invoicingStatus: "UNINVOICED",
      billRate: null,
      currency: null,
      timesheetPeriodId: 42,
      createdAt: new Date("2026-09-18T00:00:00.000Z"),
      updatedAt: new Date("2026-09-18T00:00:00.000Z"),
    };
    const period = {
      id: 42,
      orgId: "org-1",
      userMembershipId: 2,
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
      status: "OPEN",
      totalHours: "2.00",
      billableHours: "2.00",
      nonBillableHours: "0.00",
      submittedAt: null,
      approvedAt: null,
      rejectedAt: null,
      lockedAt: null,
      currentApproverMembershipId: null,
      rejectionReason: null,
      createdAt: new Date("2026-09-18T00:00:00.000Z"),
      updatedAt: new Date("2026-09-18T00:00:00.000Z"),
    };

    expect(
      periodDetailResponseSchema.safeParse({ period, entries: [entry] }).success,
    ).toBe(false);
    expect(
      periodDetailResponseSchema.safeParse({
        period,
        entries: [{ ...entry, project: { id: 7, name: "StreamlineOS" } }],
      }).success,
    ).toBe(true);
  });
});
