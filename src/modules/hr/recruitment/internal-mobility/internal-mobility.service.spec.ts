import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { InternalMobilityService } from "./internal-mobility.service";

const ORG = "org-1";
const CANDIDATE_ID = 7;
const MANAGER_MEMBERSHIP_ID = 42;

/** A select chain that answers each `.limit()` from a queue, in call order. */
function selectChain(results: unknown[][]) {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "orderBy"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain.limit = jest.fn(() => Promise.resolve(queue.shift() ?? []));
  return chain;
}

function internalApplicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    managerMembershipId: MANAGER_MEMBERSHIP_ID,
    notifiedAt: null,
    decision: "PENDING",
    jobTitle: "Staff Engineer",
    firstName: "Asha",
    ...overrides,
  };
}

interface Harness {
  service: InternalMobilityService;
  create: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  returning: jest.Mock;
  logCritical: jest.Mock;
}

function build(selectResults: unknown[][], returning: unknown[] = []): Harness {
  const chain = selectChain(selectResults);
  const set = jest.fn(() => updateChain);
  const where = jest.fn(() => updateChain);
  const returningFn = jest.fn(() => Promise.resolve(returning));
  const updateChain: Record<string, unknown> = { set, where, returning: returningFn };
  const update = jest.fn(() => updateChain);

  const db = { ...chain, update } as unknown as Db;
  const create = jest.fn(() => Promise.resolve({ id: 1 }));
  const logCritical = jest.fn(() => Promise.resolve());
  const service = new InternalMobilityService(
    db,
    { create } as never,
    { logCritical } as never,
  );
  return { service, create, update, set, returning: returningFn, logCritical };
}

describe("notifyManagerIfVisible — the confidentiality rule, at the call site", () => {
  /**
   * The rule that decides whether internal mobility gets used at all. A manager
   * who learns about an application from a notification finds out before the
   * person meant to tell them, and after that nobody in that organisation
   * applies internally again.
   */
  it.each(["APPLIED", "SHORTLISTED"])("says nothing while the application is %s", async (status) => {
    const h = build([[internalApplicationRow()]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, status);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("tells the manager once the application reaches interview", async () => {
    const h = build([[internalApplicationRow()], [{ userId: "manager-user" }]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "INTERVIEWING");

    expect(h.create).toHaveBeenCalledTimes(1);
    const notice = h.create.mock.calls[0]?.[0] as { userId: string; message: string };
    expect(notice.userId).toBe("manager-user");
    expect(notice.message).toContain("Staff Engineer");
  });

  /**
   * First name and the role, and nothing else. A notification body is
   * forwarded, screenshotted and searched, and this one is about somebody who
   * has told their manager nothing yet.
   */
  it("carries the first name and no email or surname", async () => {
    const h = build([[internalApplicationRow()], [{ userId: "manager-user" }]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "INTERVIEWING");

    const notice = h.create.mock.calls[0]?.[0] as { message: string; title: string };
    expect(notice.message).toContain("Asha");
    expect(`${notice.title} ${notice.message}`).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/);
  });

  it("stamps the notice so the next stage move does not send a second one", async () => {
    const h = build([[internalApplicationRow()], [{ userId: "manager-user" }]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "INTERVIEWING");

    expect(h.update).toHaveBeenCalledTimes(1);
    const patch = h.set.mock.calls[0]?.[0] as { internalManagerNotifiedAt: Date };
    expect(patch.internalManagerNotifiedAt).toBeInstanceOf(Date);
  });

  it("says nothing when the manager was already told", async () => {
    const h = build([[internalApplicationRow({ notifiedAt: new Date() })]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "OFFERED");
    expect(h.create).not.toHaveBeenCalled();
  });

  /**
   * An external application has a NULL decision, which is how "this is an
   * internal move" is read off the row. Without this check every external
   * candidate reaching interview would notify a manager who has no connection
   * to them.
   */
  it("says nothing about an external application", async () => {
    const h = build([[internalApplicationRow({ decision: null })]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "INTERVIEWING");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("says nothing when the department has no head", async () => {
    const h = build([[internalApplicationRow({ managerMembershipId: null, decision: "NOT_REQUIRED" })]]);
    await h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "INTERVIEWING");
    expect(h.create).not.toHaveBeenCalled();
  });

  /**
   * Never throws. It is called after the stage move has already committed, and
   * an exception would surface to the recruiter as a failed drag on a card
   * that did in fact move.
   */
  it("swallows a failure rather than failing the stage move", async () => {
    const h = build([]);
    (h.service as unknown as { db: { select: jest.Mock } }).db.select = jest.fn(() => {
      throw new Error("database is on fire");
    });
    await expect(
      h.service.notifyManagerIfVisible(ORG, CANDIDATE_ID, "INTERVIEWING"),
    ).resolves.toBeUndefined();
  });
});

describe("decide", () => {
  it("records the manager's answer and audits it", async () => {
    const h = build([], [{ id: 5, decision: "APPROVED", decidedAt: new Date() }]);
    const result = await h.service.decide(ORG, MANAGER_MEMBERSHIP_ID, "user-1", 5, "APPROVED", "Go");

    expect(result.decision).toBe("APPROVED");
    expect(h.logCritical).toHaveBeenCalledTimes(1);
    const patch = h.set.mock.calls[0]?.[0] as { internalManagerNote: string };
    expect(patch.internalManagerNote).toBe("Go");
  });

  /**
   * 404 rather than 403. A 403 on an application belonging to another manager
   * confirms the row exists, which turns an id probe into an oracle for who in
   * the organisation is quietly applying elsewhere.
   */
  it("404s on somebody else's application rather than 403", async () => {
    const h = build([], []);
    await expect(
      h.service.decide(ORG, MANAGER_MEMBERSHIP_ID, "user-1", 5, "APPROVED", null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("writes no audit entry when nothing was decided", async () => {
    const h = build([], []);
    await expect(
      h.service.decide(ORG, MANAGER_MEMBERSHIP_ID, "user-1", 5, "DECLINED", null),
    ).rejects.toThrow();
    expect(h.logCritical).not.toHaveBeenCalled();
  });
});
