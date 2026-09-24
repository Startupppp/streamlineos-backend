import { BadRequestException, UnprocessableEntityException } from "@nestjs/common";
import { getTableName, type Table } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import { applySchema } from "./dto/public.schemas";
import type { ResumeIntake } from "./careers-resume-intake";
import { recordApplication, screenOrRefuse, type ApplyJob } from "./public-careers-apply";

const JOB: ApplyJob = {
  id: 7,
  title: "Backend Engineer",
  postedBy: "recruiter-1",
  screeningQuestions: [
    {
      id: "q1",
      question: "Work permit?",
      type: "YES_NO",
      required: true,
      knockout: true,
      knockoutAnswer: "Yes",
    },
  ],
};

const INPUT = applySchema.parse({
  name: "Asha Mehta",
  email: "Asha.Mehta@example.com",
  consent: true,
  answers: { q1: "Yes" },
});

interface Captured {
  table: string;
  values: Record<string, unknown>;
}

/**
 * A transaction double that records what was inserted rather than re-describing
 * Drizzle's builder. Every method returns something the production code
 * actually calls on it, so a signature change breaks the test instead of being
 * absorbed.
 */
function makeTx(options: {
  existingCandidateId?: number;
  existingApplication?: { id: number; trackingToken: string | null } | null;
}): { tx: Db; inserted: Captured[]; updated: Captured[]; locks: unknown[] } {
  const inserted: Captured[] = [];
  const updated: Captured[] = [];
  const locks: unknown[] = [];

  const tx = {
    /**
     * Two statements come through here: the advisory lock, and the
     * aggregate-version lookup the outbox emit takes. Returning a row keeps the
     * second one honest; the lock assertion counts only the first.
     */
    execute: jest.fn((statement: unknown) => {
      locks.push(statement);
      return Promise.resolve([{ next: "1" }]);
    }),
    /**
     * Two shapes reach this: the candidate lookup (`from().where().limit()`)
     * and the vault custodian's owner fallback, which joins. Both are declared
     * so a change to either is visible here rather than throwing "not a
     * function" from inside production code.
     */
    select: jest.fn(() => {
      const terminal = (rows: unknown[]) => ({
        where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(rows)) })),
      });
      return {
        from: jest.fn(() => ({
          ...terminal(
            options.existingCandidateId === undefined
              ? [{ userId: "recruiter-1" }]
              : [{ id: options.existingCandidateId }],
          ),
          innerJoin: jest.fn(() => terminal([{ userId: "owner-1" }])),
        })),
      };
    }),
    insert: jest.fn((table: Table) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserted.push({ table: getTableName(table), values });
        return {
          returning: jest.fn(() => Promise.resolve([{ id: 101 }])),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      }),
    })),
    update: jest.fn((table: Table) => ({
      set: jest.fn((values: Record<string, unknown>) => ({
        where: jest.fn(() => {
          updated.push({ table: getTableName(table), values });
          return Promise.resolve([]);
        }),
      })),
    })),
    query: {
      candidateApplications: {
        findFirst: jest.fn(() => Promise.resolve(options.existingApplication ?? undefined)),
      },
    },
  } as unknown as Db;

  return { tx, inserted, updated, locks };
}

const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as unknown as PlanLimitsService;
const NO_RESUME: ResumeIntake = { stored: false, reason: "no-file" };

describe("public apply — the schema is the consent gate", () => {
  it("refuses a body with no consent field at all", () => {
    const parsed = applySchema.safeParse({ name: "A B", email: "a@b.com" });
    expect(parsed.success).toBe(false);
  });

  it("refuses consent: false", () => {
    expect(applySchema.safeParse({ name: "A B", email: "a@b.com", consent: false }).success).toBe(false);
  });

  /**
   * `z.coerce.boolean()` is `Boolean(value)`, and `Boolean("false")` is `true`.
   * A multipart form posting `consent=false` must not be read as consent.
   */
  it('reads the multipart string "false" as refusal, not as truthy', () => {
    expect(applySchema.safeParse({ name: "A B", email: "a@b.com", consent: "false" }).success).toBe(false);
    expect(applySchema.safeParse({ name: "A B", email: "a@b.com", consent: "0" }).success).toBe(false);
    expect(applySchema.safeParse({ name: "A B", email: "a@b.com", consent: "off" }).success).toBe(false);
  });

  it('accepts the multipart string "true"', () => {
    const parsed = applySchema.parse({ name: "A B", email: "a@b.com", consent: "true" });
    expect(parsed.consent).toBe(true);
  });

  it("accepts screening answers as a JSON string, the only shape multipart can carry", () => {
    const parsed = applySchema.parse({
      name: "A B",
      email: "a@b.com",
      consent: "true",
      answers: '{"q1":"Yes"}',
    });
    expect(parsed.answers).toEqual({ q1: "Yes" });
  });

  it("rejects an answers string that is not JSON", () => {
    expect(
      applySchema.safeParse({ name: "A B", email: "a@b.com", consent: true, answers: "not json" }).success,
    ).toBe(false);
  });
});

describe("screenOrRefuse", () => {
  it("throws 422 on a knockout so no row is written", () => {
    expect(() => screenOrRefuse(JOB, { ...INPUT, answers: { q1: "No" } })).toThrow(
      UnprocessableEntityException,
    );
  });

  it("throws 400 when a required question is unanswered", () => {
    expect(() => screenOrRefuse(JOB, { ...INPUT, answers: {} })).toThrow(BadRequestException);
  });
});

describe("recordApplication", () => {
  beforeEach(() => jest.clearAllMocks());

  it("stores consent, the screening answers and candidate.applied in one transaction", async () => {
    const { tx, inserted, locks } = makeTx({});
    const result = await recordApplication({
      tx,
      planLimits,
      orgId: "org-a",
      job: JOB,
      input: INPUT,
      answers: { q1: "Yes" },
      resume: NO_RESUME,
    });

    expect(result.duplicate).toBe(false);
    expect(result.trackingToken).toHaveLength(64);
    expect(locks.length).toBeGreaterThanOrEqual(1);

    const application = inserted.find((i) => i.table === "candidate_applications");
    expect(application?.values.consentAt).toBeInstanceOf(Date);
    expect(application?.values.screeningAnswers).toEqual({ q1: "Yes" });
    expect(application?.values.trackingToken).toBe(result.trackingToken);

    const outbox = inserted.find((i) => i.table === "outbox_events");
    expect(outbox?.values.eventType).toBe("candidate.applied");
    expect(outbox?.values.organizationId).toBe("org-a");
  });

  it("lowercases the email before it becomes the candidate's identity", async () => {
    const { tx, inserted } = makeTx({});
    await recordApplication({
      tx,
      planLimits,
      orgId: "org-a",
      job: JOB,
      input: INPUT,
      answers: {},
      resume: NO_RESUME,
    });
    expect(inserted.find((i) => i.table === "candidates")?.values.email).toBe("asha.mehta@example.com");
  });

  it("writes a vault row pointing at the stored résumé, marked with the scan verdict", async () => {
    const { tx, inserted } = makeTx({});
    await recordApplication({
      tx,
      planLimits,
      orgId: "org-a",
      job: JOB,
      input: INPUT,
      answers: {},
      resume: {
        stored: true,
        key: "org-a/candidates/resumes/cv.pdf",
        filename: "cv.pdf",
        fileType: "application/pdf",
        fileSize: 1234,
        sha256: "abc",
        avResult: "PENDING",
      },
    });
    const vault = inserted.find((i) => i.table === "candidate_documents_vault");
    expect(vault?.values.s3Key).toBe("org-a/candidates/resumes/cv.pdf");
    expect(vault?.values.documentType).toBe("RESUME");
    expect(vault?.values.avResult).toBe("PENDING");
  });

  it("does not insert a second application, and hands back the first tracking token", async () => {
    const { tx, inserted } = makeTx({
      existingCandidateId: 55,
      existingApplication: { id: 9, trackingToken: "first-token" },
    });
    const result = await recordApplication({
      tx,
      planLimits,
      orgId: "org-a",
      job: JOB,
      input: INPUT,
      answers: { q1: "Yes" },
      resume: NO_RESUME,
    });

    expect(result).toEqual({
      trackingToken: "first-token",
      duplicate: true,
      resumeStored: false,
      resumeReason: "duplicate-application",
    });
    expect(inserted.filter((i) => i.table === "candidate_applications")).toHaveLength(0);
    expect(inserted.filter((i) => i.table === "outbox_events")).toHaveLength(0);
  });

  it("mints a tracking token for an older application that never had one", async () => {
    const { tx, updated } = makeTx({
      existingCandidateId: 55,
      existingApplication: { id: 9, trackingToken: null },
    });
    const result = await recordApplication({
      tx,
      planLimits,
      orgId: "org-a",
      job: JOB,
      input: INPUT,
      answers: {},
      resume: NO_RESUME,
    });
    expect(result.trackingToken).toHaveLength(64);
    expect(updated[0]?.values.trackingToken).toBe(result.trackingToken);
  });

  it("does not spend candidate quota for an email already in the pipeline", async () => {
    const { tx } = makeTx({ existingCandidateId: 55 });
    await recordApplication({
      tx,
      planLimits,
      orgId: "org-a",
      job: JOB,
      input: INPUT,
      answers: {},
      resume: NO_RESUME,
    });
    expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();
  });
});
