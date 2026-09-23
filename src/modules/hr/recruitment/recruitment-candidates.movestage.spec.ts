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
      await service.moveStage("org-1", "user-1", 1, { stage } as never);
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

  it("is a no-op when the candidate is already in that stage", async () => {
    const { service, calls } = build({ from: "SCREENING" });
    const result = await service.moveStage("org-1", "user-1", 1, { stage: "SCREENING" } as never);
    expect(result).toEqual({ id: 1, stage: "SCREENING", changed: false });
    expect(calls).toEqual([]);
  });
});
