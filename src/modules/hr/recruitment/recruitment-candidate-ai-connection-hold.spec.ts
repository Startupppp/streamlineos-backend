import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getTenantContext } from "../../../common/tenant/tenant-context";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../../db/drizzle.module";
import { RecruitmentCandidateAiService } from "./recruitment-candidate-ai.service";
import { RecruitmentCandidateRecordsController } from "./recruitment-candidate-records.controller";

const ORG_ID = "org-recruitment";
const USER_ID = "user-recruiter";
const CANDIDATE_ID = 42;

interface Trace {
  transactionDepth: number;
  transactions: number;
  dbDepths: number[];
  providerDepths: number[];
  providerCalls: number;
}

interface QueryResults {
  candidate?: Record<string, unknown>;
  application?: Record<string, unknown> | null;
  interviews?: Record<string, unknown>[];
}

function successResult(data: Record<string, unknown>) {
  return {
    ok: true as const,
    data,
    model: "fast",
    latencyMs: 1,
    correlationId: "correlation-1",
    usage: {},
  };
}

function makeService(
  results: QueryResults,
  providerResult: ReturnType<typeof successResult> | { ok: false; kind: "provider_error" },
): { service: RecruitmentCandidateAiService; trace: Trace } {
  const trace: Trace = {
    transactionDepth: 0,
    transactions: 0,
    dbDepths: [],
    providerDepths: [],
    providerCalls: 0,
  };
  const record = <T>(value: T): Promise<T> => {
    trace.dbDepths.push(trace.transactionDepth);
    return Promise.resolve(value);
  };
  const writeChain = {
    set: () => writeChain,
    values: () => writeChain,
    onConflictDoUpdate: () => record([]),
    where: () => record([]),
  };
  const dbDouble = {
    execute: async () => [],
    query: {
      candidates: {
        findFirst: () => record(results.candidate),
      },
      candidateApplications: {
        findFirst: () => record(results.application ?? null),
      },
      interviews: {
        findMany: () => record(results.interviews ?? []),
      },
    },
    update: () => writeChain,
    insert: () => writeChain,
  };
  const db = Object.assign(dbDouble, {
    transaction: async <T>(run: (tx: Db) => Promise<T>): Promise<T> => {
      trace.transactions += 1;
      trace.transactionDepth += 1;
      try {
        return await run(db as unknown as Db);
      } finally {
        trace.transactionDepth -= 1;
      }
    },
  }) as unknown as Db;
  const gateway = {
    invokeStructured: async () => {
      trace.providerCalls += 1;
      trace.providerDepths.push(getTenantContext() ? 1 : 0);
      return providerResult;
    },
  };

  return {
    service: new RecruitmentCandidateAiService(db, gateway as never),
    trace,
  };
}

const candidate = {
  id: CANDIDATE_ID,
  firstName: "Ada",
  lastName: "Lovelace",
  email: null,
  phone: null,
  currentRole: "Engineer",
  currentCompany: "Analytical Engines",
  experienceYears: 8,
  skills: ["TypeScript"],
  resume: { resumeText: "Experienced engineer" },
};

const application = {
  id: 7,
  jobPosting: { title: "Staff Engineer", requirements: "Distributed systems" },
};

const interviews = [
  {
    id: 8,
    type: "TECHNICAL",
    scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
    scorecards: [
      {
        ratings: { technical: 4 },
        recommendation: "HIRE",
        notes: "Strong evidence",
        submittedAt: new Date("2026-09-01T01:00:00.000Z"),
      },
    ],
  },
];

describe("recruitment candidate AI connection hold", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("fails closed before invoking AI when the candidate is outside the tenant", async () => {
    const { service, trace } = makeService({}, successResult({}));

    await expect(service.aiScore(ORG_ID, CANDIDATE_ID, USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(trace.providerCalls).toBe(0);
    expect(trace.transactions).toBe(1);
    expect(trace.dbDepths).toEqual([1]);
  });

  it("rejects an invalid resume upload before invoking AI", async () => {
    const { service, trace } = makeService({ candidate }, successResult({}));
    const file = {
      size: 12,
      mimetype: "application/pdf",
      buffer: Buffer.from("resume"),
    } as Express.Multer.File;

    await expect(
      service.parseResume(ORG_ID, CANDIDATE_ID, USER_ID, file, {}),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(trace.providerCalls).toBe(0);
    expect(trace.transactions).toBe(0);
    expect(trace.dbDepths).toEqual([]);
  });

  it("stops before invoking AI when no submitted scorecard exists", async () => {
    const { service, trace } = makeService(
      { candidate, interviews: [], application },
      successResult({}),
    );

    await expect(
      service.compositeScore(ORG_ID, CANDIDATE_ID, USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(trace.providerCalls).toBe(0);
    expect(trace.transactions).toBe(1);
    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
  });

  it("does not open a write transaction after an AI score provider failure", async () => {
    const { service, trace } = makeService(
      { candidate, application },
      { ok: false, kind: "provider_error" },
    );

    await expect(service.aiScore(ORG_ID, CANDIDATE_ID, USER_ID)).rejects.toThrow(
      "AI scoring is temporarily unavailable",
    );

    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });

  it.each(["aiScore", "compositeScore", "resumeParse"] as const)(
    "opts %s out of the request-wide tenant transaction",
    (handler) => {
      expect(
        Reflect.getMetadata(
          NO_TENANT_TRANSACTION,
          RecruitmentCandidateRecordsController.prototype[handler],
        ),
      ).toBe(true);
    },
  );

  it("scores a candidate with reads and writes in two short transactions", async () => {
    const { service, trace } = makeService(
      { candidate, application },
      successResult({
        overall: 86,
        breakdown: {
          technicalSkills: 90,
          experience: 88,
          communication: 80,
          cultureFit: 84,
          leadership: 82,
        },
        summary: "Strong match",
      }),
    );

    await service.aiScore(ORG_ID, CANDIDATE_ID, USER_ID);

    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(2);
    expect(trace.transactionDepth).toBe(0);
  });

  it("builds a composite score in one short read transaction", async () => {
    const { service, trace } = makeService(
      { candidate, interviews, application },
      successResult({
        verdict: "HIRE",
        overall: 84,
        reasoning: "Consistent evidence",
        strengthsAcrossRounds: ["Technical depth"],
        concernsAcrossRounds: [],
        roundSummaries: [],
      }),
    );

    await service.compositeScore(ORG_ID, CANDIDATE_ID, USER_ID);

    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });

  it("parses a valid upload between a short candidate read and resume write", async () => {
    const { service, trace } = makeService(
      { candidate },
      successResult({
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: null,
        currentCompany: "Analytical Engines",
        currentRole: "Engineer",
        experienceYears: 8,
        skills: ["TypeScript"],
        location: null,
        education: null,
        linkedinUrl: null,
        portfolioUrl: null,
      }),
    );
    const file = {
      size: 12,
      mimetype: "text/plain",
      buffer: Buffer.from("Ada Lovelace resume"),
    } as Express.Multer.File;

    await service.parseResume(ORG_ID, CANDIDATE_ID, USER_ID, file, {});

    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(2);
    expect(trace.transactionDepth).toBe(0);
  });
});
