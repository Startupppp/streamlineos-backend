import { getTableName, type Table } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { completeHire } from "./recruitment-hire-completion";

interface Write {
  table: string;
  values: Record<string, unknown>;
}

function makeTx(options: {
  candidateStatus?: string | null;
  application?: { id: number; jobPostingId: number } | null;
  jobAfterDecrement?: { openings: number; status: string } | null;
  requisitionsFilled?: number;
}): { tx: Db; updates: Write[]; inserts: Write[] } {
  const updates: Write[] = [];
  const inserts: Write[] = [];

  const tx = {
    /** The aggregate-version lookup the outbox emit takes first. */
    execute: jest.fn(() => Promise.resolve([{ next: "1" }])),
    query: {
      candidates: {
        findFirst: jest.fn(() =>
          Promise.resolve(
            options.candidateStatus === null
              ? undefined
              : { id: 1, status: options.candidateStatus ?? "OFFER" },
          ),
        ),
      },
      candidateApplications: {
        findFirst: jest.fn(() => Promise.resolve(options.application ?? undefined)),
      },
    },
    update: jest.fn((table: Table) => ({
      set: jest.fn((values: Record<string, unknown>) => {
        const name = getTableName(table);
        const returning = jest.fn(() => {
          if (name === "job_postings")
            return Promise.resolve(
              options.jobAfterDecrement === null ? [] : [options.jobAfterDecrement ?? { openings: 0, status: "OPEN" }],
            );
          if (name === "job_requisitions")
            return Promise.resolve(
              Array.from({ length: options.requisitionsFilled ?? 1 }, (_, i) => ({ id: i + 1 })),
            );
          return Promise.resolve([]);
        });
        return {
          where: jest.fn(() => {
            updates.push({ table: name, values });
            return Object.assign(Promise.resolve([]), { returning });
          }),
        };
      }),
    })),
    insert: jest.fn((table: Table) => ({
      values: jest.fn((values: Record<string, unknown> | Record<string, unknown>[]) => {
        for (const value of Array.isArray(values) ? values : [values])
          inserts.push({ table: getTableName(table), values: value });
        return Promise.resolve(undefined);
      }),
    })),
  } as unknown as Db;

  return { tx, updates, inserts };
}

const OFFER = { id: 11, candidateId: 1, jobPostingId: 5 };

describe("completeHire", () => {
  it("moves the candidate to HIRED and accepts the application for that job", async () => {
    const { tx, updates } = makeTx({ application: { id: 30, jobPostingId: 5 } });
    const result = await completeHire(tx, "org-a", OFFER);

    expect(result.alreadyHired).toBe(false);
    expect(result.stagesWalked).toEqual(["HIRED"]);
    expect(updates.find((u) => u.table === "candidates")?.values.status).toBe("HIRED");
    expect(updates.find((u) => u.table === "candidate_applications")?.values.status).toBe("ACCEPTED");
    expect(result.applicationId).toBe(30);
  });

  /**
   * The map has no `NEW → HIRED` edge. The hire still has to land, but it must
   * be a route the map contains rather than a raw write that ignores it.
   */
  it("walks the legal route when the candidate never reached OFFER", async () => {
    const { tx, updates } = makeTx({ candidateStatus: "NEW", application: { id: 30, jobPostingId: 5 } });
    const result = await completeHire(tx, "org-a", OFFER);
    expect(result.stagesWalked).toEqual(["SCREENING", "INTERVIEW", "OFFER", "HIRED"]);
    expect(updates.find((u) => u.table === "candidates")?.values.status).toBe("HIRED");
  });

  it("consumes one opening and fills the job when the last one goes", async () => {
    const { tx, updates } = makeTx({
      application: { id: 30, jobPostingId: 5 },
      jobAfterDecrement: { openings: 0, status: "OPEN" },
    });
    const result = await completeHire(tx, "org-a", OFFER);

    expect(result.openingsRemaining).toBe(0);
    expect(result.jobFilled).toBe(true);
    expect(updates.filter((u) => u.table === "job_postings")).toHaveLength(2);
    expect(updates.filter((u) => u.table === "job_postings")[1]?.values.status).toBe("FILLED");
  });

  it("leaves a multi-opening job OPEN, and leaves its requisition alone", async () => {
    const { tx, updates } = makeTx({
      application: { id: 30, jobPostingId: 5 },
      jobAfterDecrement: { openings: 2, status: "OPEN" },
    });
    const result = await completeHire(tx, "org-a", OFFER);

    expect(result.openingsRemaining).toBe(2);
    expect(result.jobFilled).toBe(false);
    expect(result.requisitionsFilled).toBe(0);
    expect(updates.filter((u) => u.table === "job_requisitions")).toHaveLength(0);
  });

  it("marks the linked requisition FILLED once the job is filled", async () => {
    const { tx, updates } = makeTx({
      application: { id: 30, jobPostingId: 5 },
      jobAfterDecrement: { openings: 0, status: "OPEN" },
      requisitionsFilled: 1,
    });
    const result = await completeHire(tx, "org-a", OFFER);

    expect(result.requisitionsFilled).toBe(1);
    expect(updates.find((u) => u.table === "job_requisitions")?.values.status).toBe("FILLED");
  });

  it("emits candidate.hired and hire.handoff in the same transaction", async () => {
    const { tx, inserts } = makeTx({ application: { id: 30, jobPostingId: 5 } });
    await completeHire(tx, "org-a", OFFER);

    const events = inserts.filter((i) => i.table === "outbox_events").map((i) => i.values.eventType);
    expect(events).toEqual(["candidate.hired", "hire.handoff"]);
  });

  /**
   * The idempotency guard. A replayed acceptance must not consume a second
   * opening, re-accept the application, or emit the events again.
   */
  it("writes nothing at all when the candidate is already HIRED", async () => {
    const { tx, updates, inserts } = makeTx({ candidateStatus: "HIRED" });
    const result = await completeHire(tx, "org-a", OFFER);

    expect(result.alreadyHired).toBe(true);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("does nothing for a candidate that is not in this org", async () => {
    const { tx, updates, inserts } = makeTx({ candidateStatus: null });
    const result = await completeHire(tx, "org-a", OFFER);
    expect(result.alreadyHired).toBe(true);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
