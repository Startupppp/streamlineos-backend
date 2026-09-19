import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(mockTxDouble),
  ),
}));

jest.mock("../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { SurveyResponseService } from "./survey-response.service";

const ORG_ID = "org-1";
const SESSION_ID = 42;

interface SessionRow {
  id: number;
  orgId: string;
  surveyId: number;
  collectorId: number | null;
  participantId: number | null;
  status: string;
  startedAt: Date;
}

interface UpdatedRow {
  id: number;
  status: string;
}

let lockedRows: SessionRow[] = [];
let forMock: jest.Mock<Promise<SessionRow[]>, [string]>;
let updateReturning: jest.Mock<Promise<UpdatedRow[]>, []>;

interface SelectChain {
  from: (table: unknown) => SelectChain;
  where: (predicate: unknown) => SelectChain;
  for: (mode: string) => Promise<SessionRow[]>;
}

interface UpdateChain {
  set: (values: unknown) => UpdateChain;
  where: (predicate: unknown) => UpdateChain;
  returning: () => Promise<UpdatedRow[]>;
}

function buildTxDouble() {
  forMock = jest.fn((_mode: string) => Promise.resolve(lockedRows));
  updateReturning = jest.fn(() =>
    Promise.resolve([{ id: SESSION_ID, status: "submitted" }]),
  );

  const selectChain: SelectChain = {
    from: () => selectChain,
    where: () => selectChain,
    for: (mode: string) => forMock(mode),
  };

  const updateChain: UpdateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => updateReturning(),
  };

  return {
    select: jest.fn(() => selectChain),
    update: jest.fn(() => updateChain),
    query: {
      surveyAnswers: { findMany: jest.fn().mockResolvedValue([]) },
      surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 5, mode: "survey" }) },
    },
  };
}

let mockTxDouble = buildTxDouble();

function inProgressSession(): SessionRow {
  return {
    id: SESSION_ID,
    orgId: ORG_ID,
    surveyId: 5,
    collectorId: 9,
    participantId: null,
    status: "in_progress",
    startedAt: new Date(Date.now() - 30_000),
  };
}

function makeService() {
  const db = {
    execute: jest.fn().mockResolvedValue([{ org_id: ORG_ID }]),
  } as unknown as Db;

  const collectors = { incrementCounter: jest.fn().mockResolvedValue(undefined) };
  const participants = { markStatus: jest.fn().mockResolvedValue(undefined) };
  const automations = {
    record: jest.fn().mockResolvedValue(undefined),
    getRulesForEvent: jest.fn().mockResolvedValue([]),
  };
  const assessments = { completeAttempt: jest.fn().mockResolvedValue(null) };
  const leadAutomations = { run: jest.fn().mockResolvedValue(undefined) };

  const svc = new SurveyResponseService(
    db,
    collectors as never,
    participants as never,
    automations as never,
    assessments as never,
    leadAutomations as never,
  );

  return { svc, collectors, participants };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTxDouble = buildTxDouble();
  lockedRows = [inProgressSession()];
});

describe("a repeated public submit cannot record the response twice", () => {
  it("takes a FOR UPDATE row lock before reading the status, so two concurrent submits cannot both pass the guard", async () => {
    const { svc } = makeService();

    await svc.submit(SESSION_ID);

    expect(forMock).toHaveBeenCalledWith("update");
    expect(forMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateReturning.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("refuses a second submit of an already-submitted session instead of writing a second response", async () => {
    const { svc, collectors, participants } = makeService();

    await svc.submit(SESSION_ID);
    lockedRows = [{ ...inProgressSession(), status: "submitted" }];

    await expect(svc.submit(SESSION_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(updateReturning).toHaveBeenCalledTimes(1);
    expect(collectors.incrementCounter).toHaveBeenCalledTimes(1);
    expect(participants.markStatus).not.toHaveBeenCalled();
  });

  it("emits exactly one survey.response.submitted event across the repeated submit", async () => {
    const { svc } = makeService();

    await svc.submit(SESSION_ID);
    lockedRows = [{ ...inProgressSession(), status: "submitted" }];
    await expect(svc.submit(SESSION_ID)).rejects.toBeInstanceOf(BadRequestException);

    expect(OutboxWriter.emit).toHaveBeenCalledTimes(1);
  });
});
