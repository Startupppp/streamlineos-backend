import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-col-agg";
const PROJECT_ID = 42;

describe("getColumnCounts — server aggregate, never a full fetch", () => {
  it("resolves counts from a GROUP BY aggregate, not from findMany", async () => {
    let findManyCallCount = 0;
    let selectCallCount = 0;

    const aggregateRows = [
      { status: "TODO", cnt: "12" },
      { status: "IN_PROGRESS", cnt: "5" },
      { status: "DONE", cnt: "88" },
    ];

    const selectChain: Record<string, unknown> = {};
    selectChain["from"] = jest.fn(() => selectChain);
    selectChain["where"] = jest.fn(() => selectChain);
    selectChain["groupBy"] = jest.fn(() => Promise.resolve(aggregateRows));

    const db = {
      select: jest.fn(() => {
        selectCallCount++;
        return selectChain;
      }),
      query: {
        tickets: {
          findMany: jest.fn(() => {
            findManyCallCount++;
            return Promise.resolve([]);
          }),
        },
      },
    } as unknown as Db;

    const access = {} as unknown as AccessService;

    const svc = new ProjectsTicketsReadService(db, access);

    const result = await svc.getColumnCounts(ORG_ID, PROJECT_ID);

    expect(findManyCallCount).toBe(0);

    expect(selectCallCount).toBe(1);

    expect(result).toEqual({ TODO: 12, IN_PROGRESS: 5, DONE: 88 });
  });

  it("returns an empty record when the project has no tickets", async () => {
    const selectChain: Record<string, unknown> = {};
    selectChain["from"] = jest.fn(() => selectChain);
    selectChain["where"] = jest.fn(() => selectChain);
    selectChain["groupBy"] = jest.fn(() => Promise.resolve([]));

    const db = {
      select: jest.fn(() => selectChain),
      query: { tickets: { findMany: jest.fn() } },
    } as unknown as Db;

    const svc = new ProjectsTicketsReadService(db, {} as unknown as AccessService);

    const result = await svc.getColumnCounts(ORG_ID, PROJECT_ID);

    expect(result).toEqual({});
  });
});
