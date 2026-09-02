import { makeFakeDb } from "../../test/fake-select-db";
import type { Db } from "../../db/drizzle.module";
import { WorkerEngagementsService } from "./worker-engagements.service";

const ORG = "org-1";

function worker() {
  return { worker_id: "w1", organization_id: ORG, organization_person_id: "p1", worker_number: "W1", deleted_at: null, archived_at: null };
}

function engagement(overrides: Record<string, unknown>) {
  return {
    worker_engagement_id: "e1",
    organization_id: ORG,
    worker_id: "w1",
    status: "ACTIVE",
    is_primary: true,
    starts_on: "2026-01-01",
    ends_on: null,
    archived_at: null,
    ...overrides,
  };
}

function makeService(tables: Record<string, Record<string, unknown>[]>) {
  const db = makeFakeDb(tables);
  return new WorkerEngagementsService(
    db as unknown as Db,
    { ensurePerson: jest.fn() } as never,
    { logCritical: jest.fn(), log: jest.fn() } as never,
  );
}

describe("worker engagement reads exclude archived rows", () => {
  it("listEngagements omits an archived engagement", async () => {
    const service = makeService({
      workers: [worker()],
      worker_engagements: [
        engagement({ worker_engagement_id: "live" }),
        engagement({ worker_engagement_id: "archived", archived_at: new Date() }),
      ],
    });

    const rows = await service.listEngagements(ORG, "w1");

    expect(rows.map((row) => row.workerEngagementId)).toEqual(["live"]);
  });

  it("listEngagements still returns live engagements", async () => {
    const service = makeService({
      workers: [worker()],
      worker_engagements: [engagement({ worker_engagement_id: "live" })],
    });

    const rows = await service.listEngagements(ORG, "w1");

    expect(rows).toHaveLength(1);
  });
});
