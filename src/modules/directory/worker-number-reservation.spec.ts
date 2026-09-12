import { ConflictException } from "@nestjs/common";
import { getTableConfig } from "drizzle-orm/pg-core";
import { workers } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { WorkerEngagementsService } from "./worker-engagements.service";
import {
  WORKER_ERROR,
  workerNumberReservedMessage,
} from "./worker-engagement-errors";

const ORG_ID = "org-worker-number";
const ACTOR_ID = "actor-1";
const PERSON_ID = "op-1";
const WORKER_NUMBER = "W-0007";

function predicateText(where: unknown, seen = new Set<object>()): string {
  if (typeof where === "string") return where;
  if (where === null || typeof where !== "object" || seen.has(where)) return "";
  seen.add(where);
  if (Array.isArray(where))
    return where.map((item) => predicateText(item, seen)).join(" ");
  const record = where as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record["queryChunks"]))
    for (const chunk of record["queryChunks"]) parts.push(predicateText(chunk, seen));
  if (typeof record["name"] === "string") parts.push(record["name"]);
  if ("value" in record) parts.push(predicateText(record["value"], seen));
  return parts.join(" ");
}

function indexedColumnName(column: unknown): string | null {
  if (typeof column !== "object" || column === null || !("name" in column)) return null;
  const { name } = column;
  return typeof name === "string" ? name : null;
}

function uniqueViolation(constraint: string): Error {
  const driverError = Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint_name: constraint,
    table_name: "workers",
  });
  return Object.assign(new Error("Failed query"), { cause: driverError });
}

interface Harness {
  service: WorkerEngagementsService;
}

function makeHarness(insertOutcome: { error?: Error; row?: unknown }): Harness {
  const db = {
    query: {},
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn(() =>
          insertOutcome.error
            ? Promise.reject(insertOutcome.error)
            : Promise.resolve([insertOutcome.row]),
        ),
      }),
    }),
  } as unknown as Db;

  const service = new WorkerEngagementsService(
    db,
    { logCritical: jest.fn().mockResolvedValue(undefined) } as never,
    {
      ensurePersonForMember: jest
        .fn()
        .mockResolvedValue({ organizationPersonId: PERSON_ID }),
      loadPerson: jest.fn().mockResolvedValue({ organizationPersonId: PERSON_ID }),
    } as never,
  );

  jest
    .spyOn(
      service as unknown as { loadPerson: () => Promise<unknown> },
      "loadPerson" as never,
    )
    .mockResolvedValue({ organizationPersonId: PERSON_ID } as never);

  return { service };
}

function createWorker(harness: Harness): Promise<unknown> {
  return harness.service.createWorker(ORG_ID, ACTOR_ID, {
    organizationPersonId: PERSON_ID,
    workerNumber: WORKER_NUMBER,
  } as never);
}

describe("worker number reservation — P9", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("the declared constraint", () => {
    it("reserves a worker number unconditionally, including archived and deleted rows", () => {
      const config = getTableConfig(workers);
      const unconditional = config.indexes.find(
        (index) => index.config.name === "uniq_workers_org_number",
      );

      expect(unconditional?.config.unique).toBe(true);
      const predicate = predicateText(unconditional?.config.where);
      expect(predicate).toContain("worker_number");
      expect(predicate).not.toContain("archived_at");
      expect(predicate).not.toContain("deleted_at");
    });

    it("declares the active-only index over a strictly narrower row set, so it adds no constraint", () => {
      const config = getTableConfig(workers);
      const unconditional = config.indexes.find(
        (index) => index.config.name === "uniq_workers_org_number",
      );
      const activeOnly = config.indexes.find(
        (index) => index.config.name === "uniq_workers_active_org_number",
      );

      expect(activeOnly?.config.unique).toBe(true);
      expect(activeOnly?.config.columns.map(indexedColumnName)).toEqual(
        unconditional?.config.columns.map(indexedColumnName),
      );
      const narrower = predicateText(activeOnly?.config.where);
      expect(narrower).toContain("archived_at");
      expect(narrower).toContain("deleted_at");
    });
  });

  describe("reuse rejection", () => {
    it("names the reserved number instead of blaming the person record", async () => {
      const harness = makeHarness({ error: uniqueViolation("uniq_workers_org_number") });

      await expect(createWorker(harness)).rejects.toThrow(ConflictException);
      await expect(createWorker(harness)).rejects.toMatchObject({
        response: {
          code: WORKER_ERROR.NUMBER_RESERVED,
          message: workerNumberReservedMessage(WORKER_NUMBER),
        },
      });
    });

    it("says the number stays reserved after archiving", () => {
      expect(workerNumberReservedMessage(WORKER_NUMBER)).toMatch(/stays reserved/i);
      expect(workerNumberReservedMessage(WORKER_NUMBER)).toContain(WORKER_NUMBER);
    });

    it("answers the archived-row collision the same way, because the same index fires", async () => {
      const harness = makeHarness({
        error: uniqueViolation("uniq_workers_active_org_number"),
      });

      await expect(createWorker(harness)).rejects.toMatchObject({
        response: { code: WORKER_ERROR.NUMBER_RESERVED },
      });
    });

    it("keeps the person-already-a-worker answer for the person index", async () => {
      const harness = makeHarness({ error: uniqueViolation("uniq_workers_org_person") });

      await expect(createWorker(harness)).rejects.toMatchObject({
        response: {
          code: WORKER_ERROR.PERSON_ALREADY_WORKER,
          message: "This person is already a worker in this organization.",
        },
      });
    });

    it("does not swallow an unrelated database failure", async () => {
      const harness = makeHarness({ error: new Error("connection reset") });

      await expect(createWorker(harness)).rejects.toThrow("connection reset");
    });

    it("creates the worker when the number is free", async () => {
      const harness = makeHarness({
        row: { workerId: "w-1", organizationPersonId: PERSON_ID },
      });

      await expect(createWorker(harness)).resolves.toMatchObject({ workerId: "w-1" });
    });
  });
});
