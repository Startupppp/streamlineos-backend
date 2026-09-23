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

function build(options: {
  currentStep?: number;
  consented?: boolean;
  sequenceActive?: boolean;
  candidateEmail?: string | null;
  steps?: typeof STEPS;
  sendThrows?: boolean;
}) {
  const updates: Write[] = [];
  const sent: Array<{ to: string; subject: string }> = [];

  const tx = {
    select: jest.fn((projection: Record<string, unknown>) => ({
      from: jest.fn((table: Table) => {
        const name = getTableName(table);
        const rows =
          name === "email_sequence_enrollments"
            ? [{ id: 1, sequenceId: 2, candidateId: 3, currentStep: options.currentStep ?? 0 }]
            : name === "email_sequence_steps"
              ? (options.steps ?? STEPS)
              : options.consented === false
                ? []
                : [{ id: 99 }];
        const terminal = {
          orderBy: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(rows)) })),
          limit: jest.fn(() => Promise.resolve(rows)),
        };
        void projection;
        return { where: jest.fn(() => terminal) };
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
          Promise.resolve(
            options.candidateEmail === null
              ? { email: null, firstName: "A", lastName: "B" }
              : { email: options.candidateEmail ?? "a@b.com", firstName: "A", lastName: "B" },
          ),
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

  return {
    service: new CronRecruitmentSequencesService({} as never, email as never),
    updates,
    sent,
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
   * The gate this worker exists to carry. Consent is re-read per step, not once
   * at enrollment, so a withdrawal stops a sequence already running.
   */
  it("holds an enrollment whose candidate has given no consent, and stores why", async () => {
    const { service, updates, sent } = build({ consented: false });
    const outcome = await service.sendDueSequenceSteps();

    expect(outcome.heldWithoutConsent).toBe(1);
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
    const { service, updates } = build({ sendThrows: true });
    const outcome = await service.sendDueSequenceSteps();
    expect(outcome.sent).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
