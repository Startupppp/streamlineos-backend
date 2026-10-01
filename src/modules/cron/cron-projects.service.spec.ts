import { CronProjectsService } from "./cron-projects.service";
import { BuildTicketCreationService } from "../build/core/tickets";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-1";
const PROJECT_ID = 3;
const TEMPLATE_ID = 7;

const STUB_TEMPLATE = {
  id: TEMPLATE_ID,
  orgId: ORG,
  projectId: PROJECT_ID,
  title: "Weekly standup",
  description: null,
  type: "TASK" as const,
  priority: "MEDIUM" as const,
  points: null,
  assigneeMembershipId: null,
  recurrenceRule: { frequency: "weekly" as const, interval: 1 },
  recurrenceNextRunAt: new Date("2026-09-01T00:00:00Z"),
};

function makeTicketCreation() {
  return {
    create: jest.fn().mockResolvedValue({ command: {}, tickets: [{ id: 20, assigneeMembershipId: null }] }),
    createInTransaction: jest.fn().mockResolvedValue({ command: {}, tickets: [{ id: 20, assigneeMembershipId: null }] }),
    publish: jest.fn(),
  } as unknown as BuildTicketCreationService;
}

function makeInnerTx() {
  const limitFn = jest.fn().mockResolvedValue([{ projectId: PROJECT_ID, name: "TODO" }]);
  const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
  const whereFn = jest.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });

  const bulkWhere = jest.fn().mockResolvedValue([]);
  const bulkFrom = jest.fn().mockReturnValue({ where: bulkWhere });
  const bulkSelect = jest.fn().mockReturnValue({ from: bulkFrom });

  return {
    selectDistinctOn: jest.fn().mockReturnValue({ from: fromFn }),
    select: bulkSelect,
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue([]) }),
    }),
    execute: jest.fn().mockResolvedValue([]),
  };
}

function makeTx() {
  const innerTx = makeInnerTx();
  const transactionFn = jest.fn().mockImplementation(
    async (cb: (tx: typeof innerTx) => Promise<unknown>) => cb(innerTx),
  );
  return { ...innerTx, transaction: transactionFn, innerTx };
}

function makeDb() {
  return {} as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CronProjectsService.spawnBatch — canonical creation path", () => {
  it("routes recurring ticket spawning through canonical BuildTicketCreationService.createInTransaction", async () => {
    const ticketCreation = makeTicketCreation();
    const svc = new CronProjectsService(makeDb(), ticketCreation);
    const tx = makeTx();

    const count = await (svc as unknown as {
      spawnBatch: (tx: unknown, orgId: string, due: unknown[]) => Promise<number>;
    }).spawnBatch(tx, ORG, [STUB_TEMPLATE]);

    expect((ticketCreation.createInTransaction as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((ticketCreation.createInTransaction as jest.Mock)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG,
        projectId: PROJECT_ID,
        drafts: expect.arrayContaining([
          expect.objectContaining({ title: STUB_TEMPLATE.title, recurrenceParentId: TEMPLATE_ID, isRecurring: false }),
        ]),
      }),
    );
    expect(count).toBe(1);
  });

  it("returns 0 and skips createInTransaction when an error occurs during spawn", async () => {
    const ticketCreation = makeTicketCreation();
    (ticketCreation.createInTransaction as jest.Mock).mockRejectedValue(new Error("DB error"));
    const svc = new CronProjectsService(makeDb(), ticketCreation);
    const tx = makeTx();

    const count = await (svc as unknown as {
      spawnBatch: (tx: unknown, orgId: string, due: unknown[]) => Promise<number>;
    }).spawnBatch(tx, ORG, [STUB_TEMPLATE]);

    expect(count).toBe(0);
  });
});
