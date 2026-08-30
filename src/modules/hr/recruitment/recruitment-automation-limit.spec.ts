import { RecruitmentAutomationService } from "./recruitment-automation.service";
import type { Db } from "../../../db/drizzle.module";

describe("RecruitmentAutomationService — list caps", () => {
  afterEach(() => jest.resetAllMocks());

  function makeSvc(db: Db) {
    return new RecruitmentAutomationService(db, {} as never);
  }

  it("applies PIPELINE_AUTOMATION_CAP limit to listAutomations query", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { pipelineAutomations: { findMany } },
    } as unknown as Db;
    const svc = makeSvc(db);

    await svc.listAutomations("org-1");

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(500);
  });

  it("applies EMAIL_SEQUENCE_CAP limit to listSequences query", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { emailSequences: { findMany } },
    } as unknown as Db;
    const svc = makeSvc(db);

    await svc.listSequences("org-1");

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(500);
  });
});
