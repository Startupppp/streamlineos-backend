process.env.APP_URL ??= "http://localhost:1000";

import { RecruitmentCandidatesService } from "./recruitment-candidates.service";

describe("RecruitmentCandidatesService.moveStage — transactional", () => {
  it("writes candidate status and SLA row inside a single transaction", async () => {
    const updated = { id: 1, status: "SCREENING" };
    const calls: string[] = [];

    const tx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => {
              calls.push("update");
              return Promise.resolve([updated]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => {
            calls.push("sla");
            return Promise.resolve(undefined);
          },
        }),
      }),
    };

    const db = {
      query: {
        candidates: {
          findFirst: () =>
            Promise.resolve({ id: 1, status: "NEW", firstName: "A", lastName: "B", email: null }),
        },
      },
      transaction: (cb: (t: unknown) => Promise<unknown>) => {
        calls.push("tx:start");
        return cb(tx);
      },
    };

    const audit = { log: () => undefined };
    const automation = { runAutomationsForEvent: () => Promise.resolve() };

    const service = new RecruitmentCandidatesService(
      db as never,
      undefined as never,
      audit as never,
      undefined as never,
      undefined as never,
      automation as never,
      undefined as never,
      undefined as never,
    );

    const result = await service.moveStage("org-1", "user-1", 1, { stage: "SCREENING" } as never);

    expect(calls).toEqual(["tx:start", "update", "sla"]);
    expect(result).toEqual({ id: 1, stage: "SCREENING", changed: true });
  });
});
