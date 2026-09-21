import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { markProposalDeclined, markProposalExecuted, type ProposalLifecycleDeps } from "./lib/proposal-lifecycle";

/**
 * The bookkeeping half of AI action proposals, which nothing tested.
 *
 * `ai-confirmation.service.spec.ts` covers the token protocol thoroughly, but
 * every rule in `lib/proposal-lifecycle.ts` could be deleted with all 459 ai
 * tests green: the org predicate on the proposal read, "only a CONFIRMED
 * proposal can be marked executed", and the same two facts restated on the
 * write.
 *
 * Predicates are compiled with the same `PgDialect` the service spec uses and
 * checked for the bound parameter, because a mocked read returns whatever the
 * mock says regardless of its WHERE, and a mocked update applies whatever patch
 * it is handed regardless of the row it claims to have matched.
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
 * drives them. `affected` is how many rows the update reports back, so a test
 * can make the conditional write miss the way a concurrent transition would.
 */
function harness(found: Row | undefined, affected = 1) {
  const selectWhere = jest.fn((_cond: unknown) => ({
    limit: jest.fn().mockResolvedValue(found ? [found] : []),
  }));
  const updateWhere = jest.fn((_cond: unknown) =>
    Object.assign(Promise.resolve([]), {
      returning: jest
        .fn()
        .mockResolvedValue(Array.from({ length: affected }, (_unused, index) => ({ id: index + 1 }))),
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
 * `select`, so the first `where` is not necessarily this file's query.
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

  /**
   * The write used to identify the row by id alone and trust the read in front
   * of it. Under RLS a statement with no org predicate is the last line of
   * defence, and `id` is a bare serial shared across every tenant.
   */
  it("cannot write another tenant's proposal by id alone, because the UPDATE restates the org", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }));
    await markProposalExecuted(h.deps, 7, { ok: true }, ORG);

    const query = dialect.sqlToQuery(h.updateWhere.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toMatch(/"org_id"/);
    expect(query.params).toContain(ORG);
  });

  /**
   * Without the status in the WHERE, a proposal confirmed at read time and
   * executed by a racing transaction a moment later would be executed twice,
   * each run overwriting the other's result.
   */
  it("restates CONFIRMED on the write, so a racing execution cannot be recorded twice", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }));
    await markProposalExecuted(h.deps, 7, { ok: true }, ORG);

    const query = dialect.sqlToQuery(h.updateWhere.mock.calls[0]?.[0] as SQL);
    expect(query.params).toContain("CONFIRMED");
  });

  it("reports the lost race instead of logging an execution that never landed", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }), 0);

    await expect(markProposalExecuted(h.deps, 7, { ok: true }, ORG)).rejects.toThrow(
      ConflictException,
    );
    expect(h.log).not.toHaveBeenCalled();
  });
});

describe("declining a proposal", () => {
  it("reads the proposal inside the caller's org AND for the proposing user", async () => {
    const h = harness(proposal());
    await markProposalDeclined(h.deps, 7, ORG, PROPOSER);

    const params = proposalReadParams(h.selectWhere);
    expect(params).toContain(ORG);
    expect(params).toContain(PROPOSER);
  });

  it("sets status to CANCELLED and emits the declined audit event for a PROPOSED proposal", async () => {
    const h = harness(proposal());
    await markProposalDeclined(h.deps, 7, ORG, PROPOSER);

    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
    );
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.proposal.declined" }));
  });

  it("is idempotent — a CANCELLED proposal resolves without writing anything", async () => {
    const h = harness(proposal({ status: "CANCELLED" }));
    await expect(markProposalDeclined(h.deps, 7, ORG, PROPOSER)).resolves.toBeUndefined();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for an absent row so a cross-tenant probe cannot confirm the proposal exists", async () => {
    const h = harness(undefined);
    await expect(markProposalDeclined(h.deps, 7, ORG, PROPOSER)).rejects.toThrow(NotFoundException);
  });

  it("throws ConflictException for a CONFIRMED proposal so decline cannot preempt an in-flight action", async () => {
    const h = harness(proposal({ status: "CONFIRMED" }));
    await expect(markProposalDeclined(h.deps, 7, ORG, PROPOSER)).rejects.toThrow(ConflictException);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("throws ConflictException for an EXECUTED proposal so decline cannot be used after the action has fired", async () => {
    const h = harness(proposal({ status: "EXECUTED" }));
    await expect(markProposalDeclined(h.deps, 7, ORG, PROPOSER)).rejects.toThrow(ConflictException);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("the UPDATE WHERE clause restates orgId so another tenant cannot decline by id alone", async () => {
    const h = harness(proposal());
    await markProposalDeclined(h.deps, 7, ORG, PROPOSER);

    const query = dialect.sqlToQuery(h.updateWhere.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toMatch(/"org_id"/);
    expect(query.params).toContain(ORG);
  });

  it("the UPDATE WHERE clause restates userId so a colleague cannot decline someone else's proposal", async () => {
    const h = harness(proposal());
    await markProposalDeclined(h.deps, 7, ORG, PROPOSER);

    const query = dialect.sqlToQuery(h.updateWhere.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toMatch(/"user_id"/);
    expect(query.params).toContain(PROPOSER);
  });

  it("mutation proof: removing orgId from the SELECT WHERE would make the cross-tenant test pass — the param must be present", async () => {
    const h = harness(proposal());
    await markProposalDeclined(h.deps, 7, ORG, PROPOSER);

    const params = proposalReadParams(h.selectWhere);
    expect(params).toContain(ORG);
    const withoutOrg = params.filter((p) => p !== ORG);
    expect(withoutOrg).not.toContain(ORG);
  });

  it("mutation proof: removing userId from the SELECT WHERE would let any org member decline a colleague's proposal", async () => {
    const h = harness(proposal());
    await markProposalDeclined(h.deps, 7, ORG, PROPOSER);

    const params = proposalReadParams(h.selectWhere);
    expect(params).toContain(PROPOSER);
    const withoutUser = params.filter((p) => p !== PROPOSER);
    expect(withoutUser).not.toContain(PROPOSER);
  });

  it("reports the lost race instead of logging a decline that never landed", async () => {
    const h = harness(proposal(), 0);
    await expect(markProposalDeclined(h.deps, 7, ORG, PROPOSER)).rejects.toThrow(ConflictException);
    expect(h.log).not.toHaveBeenCalled();
  });
});
