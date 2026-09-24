import { getTableName, type Table } from "drizzle-orm";
import { CronRecruitmentSequencesService } from "./cron-recruitment-sequences.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";

interface Write {
  table: string;
  values: Record<string, unknown>;
}

const STEPS = [
  { stepOrder: 1, subject: "Hello", htmlBody: "<p>one</p>", delayDays: 0 },
  { stepOrder: 2, subject: "Following up", htmlBody: "<p>two</p>", delayDays: 3 },
];

const ENROLLED_AT = new Date("2026-01-01T00:00:00.000Z");

interface Options {
  currentStep?: number;
  consented?: boolean;
  sequenceActive?: boolean;
  candidateEmail?: string | null;
  candidateStatus?: string;
  steps?: typeof STEPS;
  sendThrows?: boolean;
  /** An application filed after the enrollment began. */
  appliedAt?: Date;
  /** An inbound message received after the enrollment began. */
  repliedAt?: Date;
  suppressed?: boolean;
}

/**
 * Two terminal shapes per table, because two different reads hit
 * `candidate_applications`: the consent check ends in a bare `.limit(1)`, while
 * the applied-since check sorts first. Distinguishing them in the mock is what
 * lets one test say "they consented but have not applied" — which is the normal
 * case and, with a single shared row set, was indistinguishable from the case
 * that stops every campaign on its first tick.
 */
function build(options: Options) {
  const updates: Write[] = [];
  const inserts: Write[] = [];
  const sent: Array<{ to: string; subject: string }> = [];

  const consentRows = options.consented === false ? [] : [{ id: 99 }];
  const appliedRows = options.appliedAt ? [{ appliedAt: options.appliedAt }] : [];
  const repliedRows = options.repliedAt ? [{ sentAt: options.repliedAt }] : [];

  const tx = {
    select: jest.fn((projection: Record<string, unknown>) => ({
      from: jest.fn((table: Table) => {
        const name = getTableName(table);
        void projection;

        const direct = name === "candidate_applications" ? consentRows : [];
        const ordered =
          name === "email_sequence_enrollments"
            ? [
                {
                  id: 1,
                  sequenceId: 2,
                  candidateId: 3,
                  currentStep: options.currentStep ?? 0,
                  enrolledAt: ENROLLED_AT,
                },
              ]
            : name === "email_sequence_steps"
              ? (options.steps ?? STEPS)
              : name === "candidate_applications"
                ? appliedRows
                : name === "candidate_messages"
                  ? repliedRows
                  : [];

        return {
          where: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve(direct)),
            orderBy: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(ordered)) })),
          })),
        };
      }),
    })),
    insert: jest.fn((table: Table) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values });
        return Promise.resolve([]);
      }),
    })),
    update: jest.fn((table: Table) => ({
      set: jest.fn((values: Record<string, unknown>) => ({
        where: jest.fn(() => {
          updates.push({ table: getTableName(table), values });
          return Promise.resolve([]);
        }),
      })),
    })),
    query: {
      emailSequences: {
        findFirst: jest.fn(() =>
          Promise.resolve({ isActive: options.sequenceActive ?? true, name: "Nurture" }),
        ),
      },
      candidates: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            email: options.candidateEmail === null ? null : (options.candidateEmail ?? "a@b.com"),
            firstName: "A",
            lastName: "B",
            status: options.candidateStatus ?? "NEW",
          }),
        ),
      },
    },
  };

  (forEachOrg as jest.Mock).mockImplementation(
    async (_db: unknown, _name: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
      await fn(tx, "org-1");
      return { organizations: 1, succeeded: 1, failed: 0 };
    },
  );

  const email = {
    sendEmail: jest.fn((message: { to: string; subject: string }) => {
      if (options.sendThrows) return Promise.reject(new Error("smtp down"));
      sent.push(message);
      return Promise.resolve(undefined);
    }),
  };

  const suppression = {
    findSuppressed: jest.fn((emails: string[]) =>
      Promise.resolve(options.suppressed ? new Set(emails) : new Set<string>()),
    ),
  };

  return {
    service: new CronRecruitmentSequencesService(
      {} as never,
      email as never,
      suppression as never,
    ),
    updates,
    inserts,
    sent,
    suppression,
  };
}

describe("CronRecruitmentSequencesService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends the due step and schedules the next one", async () => {
    const { service, updates, sent } = build({});
    const outcome = await service.sendDueSequenceSteps();

    expect(outcome.sent).toBe(1);
    expect(sent).toEqual([{ to: "a@b.com", subject: "Hello", html: "<p>one</p>" }]);
    expect(updates[0]?.values).toMatchObject({ currentStep: 1 });
    expect(updates[0]?.values.nextSendAt).toBeInstanceOf(Date);
  });

  /**
   * Without this row there is no record a campaign ever contacted anybody: the
   * send count lived only in a cron return value nothing persisted.
   */
  it("records the sent step as an outbound candidate message", async () => {
    const { service, inserts } = build({});
    await service.sendDueSequenceSteps();

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe("candidate_messages");
    expect(inserts[0]?.values).toMatchObject({
      candidateId: 3,
      direction: "OUTBOUND",
      channel: "EMAIL",
      subject: "Hello",
    });
  });

  /**
   * The mail has already left. Retrying would send it twice, so a failure to
   * record it advances the step anyway and complains in the log.
   */
  it("still advances the step when recording the message fails", async () => {
    const { service, updates } = build({});
    await service.sendDueSequenceSteps();
    expect(updates[0]?.values).toMatchObject({ currentStep: 1 });
  });

  /**
   * The gate this worker exists to carry. Consent is re-read per step, not once
   * at enrollment, so a withdrawal stops a sequence already running.
   */
  it("holds an enrollment whose candidate has given no consent, and stores why", async () => {
    const { service, updates, sent } = build({ consented: false });
    const outcome = await service.sendDueSequenceSteps();

    expect(outcome.heldWithoutConsent).toBe(1);
    expect(outcome.stopped.HELD_NO_CONSENT).toBe(1);
    expect(outcome.sent).toBe(0);
    expect(sent).toEqual([]);
    expect(updates[0]?.values).toEqual({ status: "HELD_NO_CONSENT", nextSendAt: null });
  });

  it("holds a candidate with no email address at all", async () => {
    const { service, sent } = build({ candidateEmail: null });
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.heldWithoutConsent).toBe(1);
    expect(sent).toEqual([]);
  });

  /**
   * The outbox would drop each send silently while the enrollment rescheduled
   * itself forever — a campaign that reads as running and sends nothing.
   */
  it("stops an enrollment whose address is on the suppression list", async () => {
    const { service, updates, sent, suppression } = build({ suppressed: true });
    const outcome = await service.sendDueSequenceSteps();

    expect(suppression.findSuppressed).toHaveBeenCalledWith(["a@b.com"], "org-1");
    expect(outcome.stopped.STOPPED_SUPPRESSED).toBe(1);
    expect(sent).toEqual([]);
    expect(updates[0]?.values).toEqual({ status: "STOPPED_SUPPRESSED", nextSendAt: null });
  });

  it("stops an enrollment when the candidate applies after being enrolled", async () => {
    const { service, updates, sent } = build({ appliedAt: new Date("2026-02-01T00:00:00.000Z") });
    const outcome = await service.sendDueSequenceSteps();

    expect(outcome.stopped.STOPPED_APPLIED).toBe(1);
    expect(sent).toEqual([]);
    expect(updates[0]?.values).toEqual({ status: "STOPPED_APPLIED", nextSendAt: null });
  });

  it("stops an enrollment when the candidate writes in", async () => {
    const { service, updates, sent } = build({ repliedAt: new Date("2026-02-01T00:00:00.000Z") });
    const outcome = await service.sendDueSequenceSteps();

    expect(outcome.stopped.STOPPED_REPLIED).toBe(1);
    expect(sent).toEqual([]);
    expect(updates[0]?.values).toEqual({ status: "STOPPED_REPLIED", nextSendAt: null });
  });

  it("stops an enrollment for a candidate who has been hired", async () => {
    const { service, updates, sent } = build({ candidateStatus: "HIRED" });
    const outcome = await service.sendDueSequenceSteps();

    expect(outcome.stopped.STOPPED_CLOSED).toBe(1);
    expect(sent).toEqual([]);
    expect(updates[0]?.values).toEqual({ status: "STOPPED_CLOSED", nextSendAt: null });
  });

  /**
   * Most nurture targets are past applicants. An unbounded "have they ever
   * applied" would stop every campaign on its first tick and report a
   * conversion the campaign never earned.
   */
  it("keeps sending to a past applicant who has not applied since enrolling", async () => {
    const { service, sent } = build({});
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing for a sequence that has been switched off", async () => {
    const { service, updates, sent } = build({ sequenceActive: false });
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.skippedInactive).toBe(1);
    expect(sent).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  it("completes the enrollment after the last step", async () => {
    const { service, updates } = build({ currentStep: 1 });
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.sent).toBe(1);
    expect(outcome.completed).toBe(1);
    expect(updates[0]?.values).toMatchObject({ status: "COMPLETED", nextSendAt: null });
  });

  it("completes an enrollment that is already past every step, without sending", async () => {
    const { service, updates, sent } = build({ currentStep: 2 });
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.completed).toBe(1);
    expect(sent).toEqual([]);
    expect(updates[0]?.values).toMatchObject({ status: "COMPLETED" });
  });

  /**
   * Advancing on a failed send would skip a message the recruiter believes went
   * out. The enrollment stays exactly where it was so the next tick retries.
   */
  it("leaves the enrollment untouched when the send fails", async () => {
    const { service, updates, inserts } = build({ sendThrows: true });
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.sent).toBe(0);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
