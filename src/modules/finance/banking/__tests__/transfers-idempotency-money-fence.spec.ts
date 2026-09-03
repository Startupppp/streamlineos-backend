import { ConflictException, UnprocessableEntityException, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { defer, lastValueFrom } from "rxjs";
import { IdempotencyInterceptor } from "../../../../common/idempotency/idempotency.interceptor";
import { IDEMPOTENCY_COMMAND, IDEMPOTENCY_LEASE_MS } from "../../../../common/idempotency/idempotency.constants";
import {
  DrizzleCommandFenceStore,
  type ClaimParams,
  type ClaimResult,
  type CommandFenceStore,
} from "../../../../common/idempotency/command-fence-store";
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../common/tenant/with-tenant";
import type { Db } from "../../../../db/drizzle.module";
import { TransfersController } from "../transfers.controller";

/*
 * POST /finance/transfers must not move the cash twice.
 *
 * `TransfersService.create` inserts `fin_bank_transfers` with no conflict target and
 * moves both balances with unconditional `± amount` SQL. Nothing in the service
 * deduplicates a second identical call, so `@Idempotent("accounting.bank-transfer.create")`
 * is the only thing standing between a retried POST and a second transfer. The fence
 * used to swallow its completion write — "best-effort: a lost completion write just
 * means the next retry re-executes after the lease" — which for this route means the
 * money moves again.
 *
 * The harness below is the production arrangement in miniature: `TenantContextInterceptor`
 * opens one transaction, establishes the tenant context, and runs the whole idempotency
 * interceptor and handler inside it, so the fence row and the balance rows commit or roll
 * back together. The interceptor under test is the real one. The property asserted is not
 * "the handler ran once" but the one that matters to a customer: **the net movement is
 * exactly one transfer, in every ordering.**
 */

const ORG = "org-fence";
const COMMAND = "accounting.bank-transfer.create";
const AMOUNT = 500;

interface FenceRow {
  fenceId: number;
  requestHash: string;
  status: "IN_FLIGHT" | "COMPLETED" | "FAILED";
  leaseExpiresAt: number;
  createdAt: Date;
  responseBody: unknown;
  responseStatus: number | null;
}

/** Applies a write and remembers how to undo it, so a rollback is a real rollback. */
class Journal {
  private readonly undo: (() => void)[] = [];

  write(apply: () => void, revert: () => void): void {
    apply();
    this.undo.push(revert);
  }

  rollback(): void {
    while (this.undo.length > 0) this.undo.pop()?.();
  }
}

/** The two bank accounts and the transfer table, with transactional writes. */
class Ledger {
  from = 10_000;
  to = 0;
  readonly transfers: { id: number; amount: number }[] = [];
  private nextId = 1;

  transfer(journal: Journal, amount: number): { id: number } {
    const id = this.nextId++;
    journal.write(
      () => this.transfers.push({ id, amount }),
      () => void this.transfers.pop(),
    );
    journal.write(
      () => void (this.from -= amount),
      () => void (this.from += amount),
    );
    journal.write(
      () => void (this.to += amount),
      () => void (this.to -= amount),
    );
    return { id };
  }

  get moved(): number {
    return this.transfers.reduce((sum, t) => sum + t.amount, 0);
  }
}

/**
 * `command_fences` as a transactional table. The real store writes through the
 * DRIZZLE proxy, which routes to the ambient tenant transaction, so its rows live and
 * die with the command's own writes; this double reproduces exactly that.
 */
class JournalledFenceStore implements CommandFenceStore {
  private readonly rows = new Map<string, FenceRow>();
  private nextId = 1;
  private journal: Journal | null = null;
  /** How many completion writes to fail — the "lost completion write" the fence swallowed. */
  failCompletions = 0;

  bind(journal: Journal | null): void {
    this.journal = journal;
  }

  private put(key: string, row: FenceRow): void {
    const previous = this.rows.get(key);
    const apply = () => void this.rows.set(key, row);
    const revert = () => {
      if (previous) this.rows.set(key, previous);
      else this.rows.delete(key);
    };
    if (this.journal) this.journal.write(apply, revert);
    else apply();
  }

  private static key(p: Pick<ClaimParams, "orgId" | "audience" | "idempotencyKey">): string {
    return `${p.orgId}|${p.audience}|${p.idempotencyKey}`;
  }

  async claim(params: ClaimParams): Promise<ClaimResult> {
    const key = JournalledFenceStore.key(params);
    const now = Date.now();
    const existing = this.rows.get(key);

    if (!existing) {
      const fenceId = this.nextId++;
      this.put(key, {
        fenceId,
        requestHash: params.requestHash,
        status: "IN_FLIGHT",
        leaseExpiresAt: now + IDEMPOTENCY_LEASE_MS,
        createdAt: new Date(now),
        responseBody: null,
        responseStatus: null,
      });
      return { kind: "proceed", fenceId };
    }

    if (existing.status === "COMPLETED") {
      if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };
      return {
        kind: "replay",
        responseBody: existing.responseBody,
        responseStatus: existing.responseStatus ?? 200,
      };
    }

    if (existing.status === "IN_FLIGHT" && existing.leaseExpiresAt > now) {
      if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };
      return { kind: "inflight" };
    }

    this.put(key, {
      ...existing,
      requestHash: params.requestHash,
      status: "IN_FLIGHT",
      leaseExpiresAt: now + IDEMPOTENCY_LEASE_MS,
      responseBody: null,
      responseStatus: null,
    });
    return { kind: "proceed", fenceId: existing.fenceId };
  }

  async complete(fenceId: number, responseStatus: number, data: unknown): Promise<void> {
    if (this.failCompletions > 0) {
      this.failCompletions -= 1;
      throw new Error("Failed query: update command_fences");
    }
    for (const [key, row] of this.rows.entries())
      if (row.fenceId === fenceId)
        return this.put(key, { ...row, status: "COMPLETED", responseBody: data, responseStatus });
  }

  async fail(fenceId: number): Promise<void> {
    for (const [key, row] of this.rows.entries())
      if (row.fenceId === fenceId) return this.put(key, { ...row, status: "FAILED" });
  }

  expireLeases(): void {
    for (const [key, row] of this.rows.entries()) this.rows.set(key, { ...row, leaseExpiresAt: 0 });
  }

  statuses(): string[] {
    return [...this.rows.values()].map((row) => row.status);
  }
}

describe("POST /finance/transfers — the cash cannot move twice", () => {
  let store: JournalledFenceStore;
  let ledger: Ledger;
  let interceptor: IdempotencyInterceptor;
  let handlerCalls: number;

  const move = () => {
    handlerCalls += 1;
    const journal = currentJournal;
    if (!journal) throw new Error("handler ran outside a transaction");
    return ledger.transfer(journal, AMOUNT);
  };

  let currentJournal: Journal | null = null;

  /** One HTTP request, arranged the way `TenantContextInterceptor` arranges it: one
   * transaction around the whole interceptor chain, committed only if the chain resolves. */
  const post = async (key: string, body: unknown, params?: Record<string, string>) => {
    const journal = new Journal();
    currentJournal = journal;
    const res = { statusCode: 201, status: (code: number) => void (res.statusCode = code) };
    const req = {
      headers: { "idempotency-key": key },
      method: "POST",
      params: params ?? {},
      query: {},
      body,
      user: { orgId: ORG, userId: "user-1", sessionId: "sess-1" },
    };
    const ctx: ExecutionContext = {
      getHandler: () => () => undefined,
      getClass: () => TransfersController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    const call: CallHandler = { handle: () => defer(async () => move()) };

    store.bind(journal);
    try {
      const responseBody = await runWithTenantContext(
        { orgId: ORG, audience: "INTERNAL", tx: {} as unknown as TenantTx },
        async () => lastValueFrom(await interceptor.intercept(ctx, call)),
      );
      return { body: responseBody, status: res.statusCode };
    } catch (error: unknown) {
      journal.rollback();
      return { error };
    } finally {
      store.bind(null);
      currentJournal = null;
    }
  };

  beforeEach(() => {
    store = new JournalledFenceStore();
    ledger = new Ledger();
    handlerCalls = 0;
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(COMMAND) } as unknown as Reflector;
    interceptor = new IdempotencyInterceptor(reflector, store);
  });

  it("(anti-vacuous) the transfer route is still fenced, and the handler really moves money", async () => {
    const declared = new Reflector().get<string | undefined>(
      IDEMPOTENCY_COMMAND,
      TransfersController.prototype.create,
    );
    expect(declared).toBe(COMMAND);

    const first = await post("key-1", { amount: AMOUNT });
    expect(first.error).toBeUndefined();
    expect(ledger.moved).toBe(AMOUNT);
    expect(ledger.from).toBe(10_000 - AMOUNT);
    expect(ledger.to).toBe(AMOUNT);
    expect(handlerCalls).toBe(1);
  });

  it("replays a plain retry instead of transferring again", async () => {
    const first = await post("key-1", { amount: AMOUNT });
    const second = await post("key-1", { amount: AMOUNT });

    expect(second.error).toBeUndefined();
    expect(second.body).toEqual(first.body);
    expect(handlerCalls).toBe(1);
    expect(ledger.moved).toBe(AMOUNT);
  });

  it("replays a retry that arrives after the lease has expired", async () => {
    await post("key-1", { amount: AMOUNT });
    store.expireLeases();
    const retry = await post("key-1", { amount: AMOUNT });

    expect(retry.error).toBeUndefined();
    expect(handlerCalls).toBe(1);
    expect(ledger.moved).toBe(AMOUNT);
    expect(ledger.from).toBe(10_000 - AMOUNT);
  });

  /*
   * THE ASSERTION THAT MATTERS.
   *
   * The completion write fails, then the client retries past the lease — the exact
   * sequence the swallowed catch declared harmless. With the write swallowed the first
   * request committed the transfer behind an IN_FLIGHT fence and the retry re-executed,
   * moving 1,000 out of an account that was asked for 500. Awaiting the completion makes
   * the first request roll back instead, so the retry is the only movement there is.
   */
  it("moves the money exactly once when the completion write is lost and the client retries", async () => {
    store.failCompletions = 1;

    const first = await post("key-1", { amount: AMOUNT });
    expect(first.error).toBeInstanceOf(Error);
    expect(ledger.moved).toBe(0);
    expect(ledger.from).toBe(10_000);

    store.expireLeases();
    const retry = await post("key-1", { amount: AMOUNT });

    expect(retry.error).toBeUndefined();
    expect(ledger.moved).toBe(AMOUNT);
    expect(ledger.from).toBe(10_000 - AMOUNT);
    expect(ledger.to).toBe(AMOUNT);
    expect(handlerCalls).toBe(2);
  });

  it("moves the money exactly once however many completion writes are lost", async () => {
    store.failCompletions = 3;
    for (let attempt = 0; attempt < 4; attempt++) {
      await post("key-1", { amount: AMOUNT });
      store.expireLeases();
    }
    expect(ledger.moved).toBe(AMOUNT);
    expect(ledger.from + ledger.to).toBe(10_000);
    expect(store.statuses()).toEqual(["COMPLETED"]);
  });

  it("rejects a concurrent duplicate rather than transferring twice", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    const slowCall: CallHandler = {
      handle: () =>
        defer(async () => {
          await gate;
          return move();
        }),
    };
    const res = { statusCode: 201, status: () => undefined };
    const req = {
      headers: { "idempotency-key": "key-1" },
      method: "POST",
      params: {},
      query: {},
      body: { amount: AMOUNT },
      user: { orgId: ORG, userId: "user-1", sessionId: "sess-1" },
    };
    const ctx: ExecutionContext = {
      getHandler: () => () => undefined,
      getClass: () => TransfersController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    const journal = new Journal();
    currentJournal = journal;
    store.bind(journal);
    const inFlight = runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: {} as unknown as TenantTx },
      async () => lastValueFrom(await interceptor.intercept(ctx, slowCall)),
    );

    await expect(post("key-1", { amount: AMOUNT })).resolves.toMatchObject({
      error: expect.any(ConflictException),
    });

    currentJournal = journal;
    store.bind(journal);
    release();
    await inFlight;
    store.bind(null);
    currentJournal = null;

    expect(ledger.moved).toBe(AMOUNT);
    expect(handlerCalls).toBe(1);
  });

  it("refuses a reused key that names a different transfer, rather than replaying the first", async () => {
    await post("key-1", { amount: AMOUNT });
    const other = await post("key-1", { amount: 9_000 });

    expect(other.error).toBeInstanceOf(UnprocessableEntityException);
    expect(ledger.moved).toBe(AMOUNT);
    expect(handlerCalls).toBe(1);
  });

  it("refuses a reused key on a different resource path, which the old body-only hash replayed", async () => {
    await post("key-1", {}, { transferId: "a" });
    const other = await post("key-1", {}, { transferId: "b" });

    expect(other.error).toBeInstanceOf(UnprocessableEntityException);
    expect(handlerCalls).toBe(1);
  });
});

describe("DrizzleCommandFenceStore.complete — the swallow is gone", () => {
  it("propagates a failed completion write instead of returning as if it had landed", async () => {
    const failure = new Error("Failed query: update command_fences");
    Object.defineProperty(failure, "cause", {
      value: Object.assign(new Error("deadlock detected"), {
        code: "40P01",
        table_name: "command_fences",
      }),
    });

    const db = {
      update: () => ({ set: () => ({ where: () => Promise.reject(failure) }) }),
    } as unknown as Db;

    const store = new DrizzleCommandFenceStore(db);
    await expect(store.complete(7, 201, { created: true })).rejects.toBe(failure);
  });

  it("logs rather than swallows when the FAILED stamp cannot be written", async () => {
    const failure = new Error("Failed query: update command_fences");
    const db = {
      update: () => ({ set: () => ({ where: () => Promise.reject(failure) }) }),
    } as unknown as Db;
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const spy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      });

    try {
      await new DrizzleCommandFenceStore(db).fail(7);
    } finally {
      spy.mockRestore();
      void original;
    }

    expect(written.join("")).toContain("could not stamp the fence FAILED");
  });
});
