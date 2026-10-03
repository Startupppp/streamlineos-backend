import { NotFoundException } from "@nestjs/common";
import { PublishingService } from "./publishing.service";
import type { Db } from "../../../db/drizzle.module";

const stub = <T,>() => ({}) as T;

describe("POST /payroll/runs/:runId/payslips/retry-failed — an unknown run is a 404", () => {
  function make(run: { id: number } | undefined) {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) },
        payslipPublications: { findMany },
      },
    } as unknown as Db;
    const svc = new PublishingService(
      db,
      stub<ConstructorParameters<typeof PublishingService>[1]>(),
      stub<ConstructorParameters<typeof PublishingService>[2]>(),
      stub<ConstructorParameters<typeof PublishingService>[3]>(),
      stub<ConstructorParameters<typeof PublishingService>[4]>(),
      stub<ConstructorParameters<typeof PublishingService>[5]>(),
      stub<ConstructorParameters<typeof PublishingService>[6]>(),
      stub<ConstructorParameters<typeof PublishingService>[7]>(),
      stub<ConstructorParameters<typeof PublishingService>[8]>(),
    );
    return { svc, findMany };
  }

  it("refuses a run id the org does not own, and never reads its publications", async () => {
    const { svc, findMany } = make(undefined);

    await expect(svc.retryFailed("org-attacker", 1, "u-1")).rejects.toThrow(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reports nothing to retry for the org's own run with no failures (control)", async () => {
    const { svc } = make({ id: 1 });

    await expect(svc.retryFailed("org-owner", 1, "u-1")).resolves.toEqual({
      published: 0,
      total: 0,
      heldCount: 0,
      runStatus: null,
      retried: 0,
    });
  });
});
