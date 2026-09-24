process.env.APP_URL ??= "http://localhost:1000";

import { getTableName, type Table } from "drizzle-orm";
import { UnprocessableEntityException } from "@nestjs/common";
import { RecruitmentCandidatesService } from "./recruitment-candidates.service";

interface Write {
  table: string;
  values: Record<string, unknown>;
}

function build(options: {
  from?: string;
  application?: { id: number; jobPostingId: number } | null;
  email?: string | null;
}) {
  const calls: string[] = [];
  const updates: Write[] = [];
  const inserts: Write[] = [];

  const tx = {
    /** The aggregate-version lookup the outbox emit takes first. */
    execute: () => Promise.resolve([{ next: "1" }]),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const name = getTableName(table);
          updates.push({ table: name, values });
          calls.push(name === "candidates" ? "update" : `update:${name}`);
          return Object.assign(Promise.resolve([]), {
            returning: () => Promise.resolve([{ id: 1, status: values.status }]),
          });
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table);
        inserts.push({ table: name, values });
        if (name === "candidate_sla_tracking") {
          calls.push("sla");
          return { onConflictDoUpdate: () => Promise.resolve(undefined) };
        }
        calls.push("outbox");
        return Promise.resolve(undefined);
      },
    }),
    query: {
      candidateApplications: {
        findFirst: () => Promise.resolve(options.application ?? undefined),
      },
    },
  };

  const db = {
    query: {
      candidates: {
        findFirst: () =>
          Promise.resolve({
            id: 1,
            status: options.from ?? "NEW",
            firstName: "A",
            lastName: "B",
            email: options.email ?? null,
          }),
      },
    },
    transaction: (cb: (t: unknown) => Promise<unknown>) => {
      calls.push("tx:start");
      return cb(tx);
    },
  };

  /**
   * `REJECTED` additionally notifies every holder of `hr:interviews:manage`, so
   * the access and notification collaborators are real enough to be called.
   */
  const service = new RecruitmentCandidatesService(
    db as never,
    undefined as never,
    { log: () => undefined } as never,
    { create: () => Promise.resolve(undefined) } as never,
    undefined as never,
    { runAutomationsForEvent: () => Promise.resolve() } as never,
    undefined as never,
    { membersWithPermission: () => Promise.resolve([]) } as never,
    /*
      The internal-mobility notice. A real double rather than `undefined`,
      because `moveStage` calls it on every transition that maps to an
      application status — an undefined here would only fail on whichever case
      the next person happened to write a test for.
    */
    { notifyManagerIfVisible: () => Promise.resolve() } as never,
  );

  return { service, calls, updates, inserts };
}

describe("RecruitmentCandidatesService.moveStage — transactional", () => {
  it("writes candidate status, SLA row, application status and the event in one transaction", async () => {
    const { service, calls, updates, inserts } = build({
      application: { id: 30, jobPostingId: 5 },
    });

    const result = await service.moveStage("org-1", "user-1", 1, { stage: "SCREENING" } as never);

    expect(calls).toEqual([
      "tx:start",
      "update",
      "sla",
      "update:candidate_applications",
      "outbox",
    ]);
    expect(result).toEqual({ id: 1, stage: "SCREENING", changed: true });
    expect(updates.find((u) => u.table === "candidate_applications")?.values.status).toBe(
      "SHORTLISTED",
    );
    const event = inserts.find((i) => i.table === "outbox_events");
    expect(event?.values.eventType).toBe("candidate.moved");
    expect(event?.values.payload).toMatchObject({
      candidateId: 1,
      jobPostingId: 5,
      fromStage: "NEW",
      toStage: "SCREENING",
    });
  });

  it.each([
    ["SCREENING", "SHORTLISTED", "candidate.moved"],
    ["REJECTED", "REJECTED", "candidate.rejected"],
  ] as const)(
    "moving NEW → %s sets the application to %s and emits %s",
    async (stage, applicationStatus, eventType) => {
      const { service, updates, inserts } = build({ application: { id: 30, jobPostingId: 5 } });
      /* A reject refuses without a reason now, so this row carries one. The
         gate's own cases live in `disposition/rejection-reasons.spec.ts`. */
      const input =
        stage === "REJECTED" ? { stage, rejectionReason: "NOTICE_PERIOD" } : { stage };
      await service.moveStage("org-1", "user-1", 1, input as never);
      expect(updates.find((u) => u.table === "candidate_applications")?.values.status).toBe(
        applicationStatus,
      );
      expect(inserts.find((i) => i.table === "outbox_events")?.values.eventType).toBe(eventType);
    },
  );

  it("moving OFFER → HIRED sets the application ACCEPTED and emits candidate.hired", async () => {
    const { service, updates, inserts } = build({
      from: "OFFER",
      application: { id: 30, jobPostingId: 5 },
    });
    await service.moveStage("org-1", "user-1", 1, { stage: "HIRED" } as never);
    expect(updates.find((u) => u.table === "candidate_applications")?.values.status).toBe("ACCEPTED");
    expect(inserts.find((i) => i.table === "outbox_events")?.values.eventType).toBe("candidate.hired");
  });

  it("still emits the event for a candidate who has no application", async () => {
    const { service, updates, inserts } = build({ application: null });
    await service.moveStage("org-1", "user-1", 1, { stage: "SCREENING" } as never);
    expect(updates.filter((u) => u.table === "candidate_applications")).toHaveLength(0);
    expect(inserts.find((i) => i.table === "outbox_events")?.values.payload).toMatchObject({
      jobPostingId: null,
    });
  });

  /**
   * An illegal move must leave nothing behind — not a half-updated application
   * and not an event a subscriber would act on.
   */
  it("writes nothing at all for a transition the map forbids", async () => {
    const { service, calls, updates, inserts } = build({ from: "NEW" });
    await expect(
      service.moveStage("org-1", "user-1", 1, { stage: "OFFER" } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  /**
   * The gate is wired in, not merely written. A pure function that refuses a
   * reasonless reject is worth nothing if `moveStage` never calls it, and a
   * rejection recorded before the refusal would leave a candidate marked
   * REJECTED with an empty disposition — indistinguishable from history.
   */
  it("refuses a reject with no reason and writes nothing", async () => {
    const { service, calls, updates, inserts } = build({ from: "INTERVIEW" });
    await expect(
      service.moveStage("org-1", "user-1", 1, { stage: "REJECTED" } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("refuses a reject whose reason is OTHER with no note", async () => {
    const { service, calls } = build({ from: "INTERVIEW" });
    await expect(
      service.moveStage("org-1", "user-1", 1, {
        stage: "REJECTED",
        rejectionReason: "OTHER",
      } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toEqual([]);
  });

  it("stores the reason on the candidate and carries the code on the event", async () => {
    const { service, updates, inserts } = build({
      from: "INTERVIEW",
      application: { id: 30, jobPostingId: 5 },
    });
    await service.moveStage("org-1", "user-1", 1, {
      stage: "REJECTED",
      rejectionReason: "OTHER",
      rejectionNote: "Role re-scoped mid-loop.",
    } as never);

    expect(updates.find((u) => u.table === "candidates")?.values).toMatchObject({
      status: "REJECTED",
      rejectionReason: "OTHER",
      rejectionNote: "Role re-scoped mid-loop.",
    });
    /*
      `recruitment-webhook-events.ts` has documented a `reason` on
      `candidate.rejected` since the event existed and nothing ever sent one.
      The code travels, never the label — a subscriber keying on prose would
      break the next time the wording changed.
    */
    expect(inserts.find((i) => i.table === "outbox_events")?.values.payload).toMatchObject({
      reason: "OTHER",
      reasonNote: "Role re-scoped mid-loop.",
    });
  });

  /**
   * Re-opening clears the reason. A rejection left on somebody who is back in
   * Screening renders on their detail page as a live rejection, and a report
   * grouping by reason would count a candidate still being interviewed.
   */
  it("clears the reason when a rejected candidate is re-opened", async () => {
    const { service, updates } = build({ from: "REJECTED" });
    await service.moveStage("org-1", "user-1", 1, { stage: "SCREENING" } as never);
    expect(updates.find((u) => u.table === "candidates")?.values).toMatchObject({
      status: "SCREENING",
      rejectionReason: null,
      rejectionNote: null,
    });
  });

  it("is a no-op when the candidate is already in that stage", async () => {
    const { service, calls } = build({ from: "SCREENING" });
    const result = await service.moveStage("org-1", "user-1", 1, { stage: "SCREENING" } as never);
    expect(result).toEqual({ id: 1, stage: "SCREENING", changed: false });
    expect(calls).toEqual([]);
  });
});

/**
 * The PATCH endpoint is the second way to reject somebody — it is what the
 * candidate detail page's status select calls — so it is tested beside the
 * board rather than in a file of its own. A required field with an untested
 * second door is how the door stays open.
 */
function buildForUpdate(from: string) {
  const updates: Write[] = [];
  const db = {
    query: {
      candidates: {
        findFirst: () =>
          Promise.resolve({
            id: 1,
            status: from,
            firstName: "A",
            lastName: "B",
            email: "a@example.com",
          }),
      },
    },
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table: getTableName(table), values });
          return Promise.resolve([]);
        },
      }),
    }),
  };

  const service = new RecruitmentCandidatesService(
    db as never,
    { invalidateNamespace: () => Promise.resolve() } as never,
    { log: () => undefined } as never,
    { create: () => Promise.resolve(undefined) } as never,
    { sendEmail: () => Promise.resolve(undefined) } as never,
    { runAutomationsForEvent: () => Promise.resolve() } as never,
    undefined as never,
    { membersWithPermission: () => Promise.resolve([]) } as never,
    { notifyManagerIfVisible: () => Promise.resolve() } as never,
  );

  return { service, updates };
}

describe("RecruitmentCandidatesService.update — the second reject door", () => {
  it("refuses a PATCH to REJECTED with no reason and writes nothing", async () => {
    const { service, updates } = buildForUpdate("INTERVIEW");
    await expect(
      service.update("org-1", 1, { status: "REJECTED" } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(updates).toHaveLength(0);
  });

  it("refuses OTHER with no note", async () => {
    const { service, updates } = buildForUpdate("INTERVIEW");
    await expect(
      service.update("org-1", 1, { status: "REJECTED", rejectionReason: "OTHER" } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(updates).toHaveLength(0);
  });

  it("stores the reason when one is given", async () => {
    const { service, updates } = buildForUpdate("INTERVIEW");
    await service.update("org-1", 1, {
      status: "REJECTED",
      rejectionReason: "COMPENSATION",
    } as never);
    expect(updates[0]?.values).toMatchObject({
      status: "REJECTED",
      rejectionReason: "COMPENSATION",
      rejectionNote: null,
    });
  });

  /**
   * A PATCH that changes only a phone number must not demand a rejection
   * reason, and must not blank the one already on the row — an edit sheet that
   * happened to include the unchanged status would otherwise erase the record
   * of why somebody was turned down.
   */
  it("leaves the reason alone when the status is untouched", async () => {
    const { service, updates } = buildForUpdate("REJECTED");
    await service.update("org-1", 1, { phone: "+919876543210" } as never);
    expect(updates[0]?.values).not.toHaveProperty("rejectionReason");
  });

  it("leaves the reason alone when a PATCH restates the status it already has", async () => {
    const { service, updates } = buildForUpdate("REJECTED");
    await service.update("org-1", 1, { status: "REJECTED" } as never);
    expect(updates[0]?.values).not.toHaveProperty("rejectionReason");
  });
});
