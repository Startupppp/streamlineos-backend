import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import {
  cancelProposal,
  getProposalExecutedResult,
  markProposalExecuted,
  sweepExpiredProposals,
  type ProposalLifecycleDeps,
} from "./lib/proposal-lifecycle";

/**
 * The bookkeeping half of AI action proposals, which nothing tested.
 *
 * `ai-confirmation.service.spec.ts` covers the token protocol thoroughly, but
 * every rule in `lib/proposal-lifecycle.ts` could be deleted with all 459 ai
 * tests green: the org predicate on each of the three proposal reads, "only a
 * CONFIRMED proposal can be marked executed", "only an EXECUTED proposal has a
 * result", "only the proposer may cancel", "only a PROPOSED proposal can be
 * cancelled", and both predicates on the expiry sweep. `cancel` and
 * `getExecutedResult` had no test at all, and the sweep's test used a fake that
 * ignores its WHERE, so dropping "still PROPOSED" — which would expire proposals
 * already confirmed or executed — changed nothing it could see.
 *
 * Predicates are compiled with the same `PgDialect` the service spec uses and
 * checked for the bound parameter, because a mocked read returns whatever the
 * mock says regardless of its WHERE.
 */

const dialect = new PgDialect();
const ORG = "org-proposer";
const PROPOSER = "user-proposer";

type Status = "PROPOSED" | "CONFIRMED" | "EXECUTED" | "EXPIRED" | "CANCELLED";

interface Row {
  id: number;
  orgId: string;
  userId: string;
  action: string;
  status: Status;
  result: Record<string, unknown> | null;
}

function proposal(overrides: Partial<Row> = {}): Row {
  return {
    id: 7,
    orgId: ORG,
    userId: PROPOSER,
    action: "send_email",
    status: "PROPOSED",
    result: null,
    ...overrides,
  };
}

/**
 * One proposal read (select → from → where → limit) and any number of updates,
 * all reachable through `db.transaction`, which is how `runInTenantTransaction`
 * drives them. An update's `where` is both awaitable (the bookkeeping writes) and
 * has `.returning` (the sweep).
 */
function harness(found: Row | undefined) {
  const selectWhere = jest.fn((_cond: unknown) => ({
    limit: jest.fn().mockResolvedValue(found ? [found] : []),
  }));
  const updateWhere = jest.fn((_cond: unknown) =>
    Object.assign(Promise.resolve([]), {
      returning: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    }),
  );
  const updateSet = jest.fn((_patch: Record<string, unknown>) => ({ where: updateWhere }));
  const update = jest.fn((_table: unknown) => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    select: jest.fn((_fields?: unknown) => ({
      from: jest.fn((_table: unknown) => ({ where: selectWhere })),
    })),
    update,
    execute: jest.fn().mockResolvedValue([]),
    transaction: async <T>(cb: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => cb(db),
  };
  const log = jest.fn();
  const deps: ProposalLifecycleDeps = {
    db: db as unknown as Db,
    audit: { log } as unknown as AuditService,
  };
  return { deps, selectWhere, update, updateSet, updateWhere, log };
}

/**
 * The proposal read, picked out by its table. Every transaction
 * `runInTenantTransaction` opens makes a read of its own through the same mocked
 * `select` (three `where` calls on a path with two transactions), so the first
 * `where` is not necessarily this file's query.
 */
function proposalReadParams(selectWhere: jest.Mock): unknown[] {
  const reads = selectWhere.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (cond): cond is SQL => typeof cond === "object" && cond !== null && "queryChunks" in cond,
    )
    .map((cond) => dialect.sqlToQuery(cond))
    .filter((query) => query.sql.includes('"ai_action_proposals"'));
  expect(reads).toHaveLength(1);
  return reads[0]?.params ?? [];
}

describe("marking a proposal executed", () => {
  it("reads the proposal only inside the caller's org", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }));
    await markProposalExecuted(h.deps, 7, { ok: true }, ORG);

    expect(proposalReadParams(h.selectWhere)).toContain(ORG);
  });

  it("refuses to record execution of a proposal nobody confirmed, and writes nothing", async () => {
    const h = harness(proposal({ status: "PROPOSED" }));

    await expect(markProposalExecuted(h.deps, 7, { ok: true }, ORG)).rejects.toThrow(
      BadRequestException,
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("records execution, and its result, on a confirmed proposal", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }));
    await markProposalExecuted(h.deps, 7, { ok: true }, ORG);

    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "EXECUTED", result: { ok: true } }),
    );
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.proposal.executed" }));
  });
});

describe("reading an executed result", () => {
  it("reads only inside the caller's org", async () => {
    const h = harness(proposal({ status: "EXECUTED", result: { sent: 3 } }));

    await expect(getProposalExecutedResult(h.deps, 7, ORG)).resolves.toEqual({ sent: 3 });
    expect(proposalReadParams(h.selectWhere)).toContain(ORG);
  });

  /** A CONFIRMED proposal may carry a stale result from nowhere; only execution makes one real. */
  it("returns nothing for a proposal that has not executed", async () => {
    const h = harness(proposal({ status: "CONFIRMED", result: { sent: 3 } }));
    await expect(getProposalExecutedResult(h.deps, 7, ORG)).resolves.toBeNull();
  });
});

describe("cancelling a proposal", () => {
  it("reads the proposal only inside the caller's org", async () => {
    const h = harness(proposal());
    await cancelProposal(h.deps, 7, { orgId: ORG, userId: PROPOSER });

    expect(proposalReadParams(h.selectWhere)).toContain(ORG);
  });

  /**
   * A proposal is a pending action on one person's behalf. A colleague in the
   * same org cancelling it is deciding about somebody else's action.
   */
  it("refuses anyone but the proposer, and writes nothing", async () => {
    const h = harness(proposal());

    await expect(
      cancelProposal(h.deps, 7, { orgId: ORG, userId: "user-colleague" }),
    ).rejects.toThrow(ForbiddenException);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses to cancel a proposal that is no longer pending, and writes nothing", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }));

    await expect(cancelProposal(h.deps, 7, { orgId: ORG, userId: PROPOSER })).rejects.toThrow(
      BadRequestException,
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("cancels the proposer's own pending proposal", async () => {
    const h = harness(proposal());
    await cancelProposal(h.deps, 7, { orgId: ORG, userId: PROPOSER });

    expect(h.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "CANCELLED" }));
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.proposal.cancelled" }));
  });
});

describe("the expiry sweep", () => {
  /**
   * Both halves of the WHERE are the rule. Without "still PROPOSED" the sweep
   * would mark confirmed and executed proposals EXPIRED; without "past expiry" it
   * would expire every pending proposal the moment it ran.
   */
  it("expires only proposals still pending and already past their expiry", async () => {
    const h = harness(undefined);

    await expect(sweepExpiredProposals(h.deps)).resolves.toBe(2);

    expect(h.updateWhere).toHaveBeenCalledTimes(1);
    const query = dialect.sqlToQuery(h.updateWhere.mock.calls[0]?.[0] as SQL);
    expect(query.params).toContain("PROPOSED");
    expect(query.sql).toMatch(/"expires_at" </);
  });
});
