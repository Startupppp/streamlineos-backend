import { AiJobsService } from "./ai-jobs.service";
import { runWithObservabilityContext } from "../../../common/observability/observability-context";

type MockQueryResult = { id: number };

function buildInsertChain(rows: MockQueryResult[] = [{ id: 1 }]) {
  const values = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) });
  return { values };
}

function buildDb(insertChain: ReturnType<typeof buildInsertChain>) {
  return {
    query: { aiJobs: { findFirst: jest.fn().mockResolvedValue(null) } },
    insert: jest.fn().mockReturnValue(insertChain),
    select: jest
      .fn()
      .mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ live: 0 }]) }) }),
  };
}

describe("AiJobsService.enqueue — ambient correlation id", () => {
  it("fills correlation_id from the ambient request context when the caller supplies none", async () => {
    const insertChain = buildInsertChain([{ id: 1 }]);
    const db = buildDb(insertChain);
    const svc = new AiJobsService(db as never);

    await runWithObservabilityContext({ correlationId: "req-trace-ambient" }, () =>
      svc.enqueue({ orgId: "org-1", type: "send.email", payload: {} }),
    );

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "req-trace-ambient" }),
    );
  });

  it("keeps correlation_id null when no ambient context exists, so a background sweep does not fabricate one", async () => {
    const insertChain = buildInsertChain([{ id: 1 }]);
    const db = buildDb(insertChain);
    const svc = new AiJobsService(db as never);

    await svc.enqueue({ orgId: "org-1", type: "send.email", payload: {} });

    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ correlationId: null }));
  });

  it("lets an explicitly supplied correlationId win over the ambient one", async () => {
    const insertChain = buildInsertChain([{ id: 1 }]);
    const db = buildDb(insertChain);
    const svc = new AiJobsService(db as never);

    await runWithObservabilityContext({ correlationId: "req-ambient" }, () =>
      svc.enqueue({
        orgId: "org-1",
        type: "send.email",
        payload: {},
        correlationId: "explicit-value",
      }),
    );

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "explicit-value" }),
    );
  });
});
