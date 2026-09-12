import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostingCommandService } from "./posting-command.service";
import { AdapterRejection } from "./posting-command.types";

/**
 * ACC-15. Every module posts through the same adapter, so the adapter is where
 * a refusal has to survive — including a refusal the caller throws away.
 *
 * One caller already does. `payroll-posting.service.ts` wraps its paid
 * disbursement posting in `catch (err) { this.logger.error(...) }`, so a locked
 * period or a missing `net_pay_clearing` account leaves the payroll run looking
 * posted with no journal behind it and nothing but a log line to say otherwise.
 * That code is payroll's business logic and this pack may not change it —
 * the orchestrator's fence is explicit that payroll may *call*
 * `PostingCommandService` and that only the adapter contract is ours to harden.
 *
 * So the contract is hardened instead: the adapter records every refusal
 * itself, outside the caller's transaction, and a caller that swallows one can
 * no longer make it invisible.
 */

interface Recorded {
  action: string;
  result?: string;
  metadata?: Record<string, unknown>;
  userId?: string | null;
  systemActor?: string;
  resourceId?: string | null;
}

function serviceThatFails(error: unknown, options: { auditThrows?: boolean } = {}) {
  const recorded: Recorded[] = [];
  const audit = {
    logCriticalOutsideTransaction: async (entry: Recorded) => {
      recorded.push(entry);
      if (options.auditThrows) throw new Error("audit table unavailable");
    },
  } as never;

  const books = { findDefault: async () => ({ id: "book-1", baseCurrency: "INR" }) } as never;
  const ledger = {
    post: () => {
      throw error;
    },
  } as never;
  const db = {} as never;

  return { service: new PostingCommandService(db, books, ledger, audit), recorded };
}

const COMMAND = {
  sourceType: "payroll_run" as const,
  sourceId: "run-7",
  purpose: "post",
  journalDate: "2026-09-30",
  lines: [
    { accountId: "acc-1", debitMinor: 500 },
    { accountId: "acc-2", creditMinor: 500 },
  ],
};

describe("a refused posting leaves a trace the caller cannot erase", () => {
  it("records the refusal, with the code and the source key", async () => {
    const rejection = new AdapterRejection(
      "UNKNOWN_ACCOUNT_TAG",
      'No account is tagged "net_pay_clearing" in this book',
    );
    const { service, recorded } = serviceThatFails(rejection);

    await expect(service.submit("org-1", "user-1", COMMAND, {} as never)).rejects.toThrow(
      rejection,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.action).toBe("accounting.posting.refused");
    expect(recorded[0]!.result).toBe("FAILURE");
    expect(recorded[0]!.metadata?.code).toBe("UNKNOWN_ACCOUNT_TAG");
    /* The idempotency key, so the row points at the exact posting attempt. */
    expect(recorded[0]!.resourceId).toBe("payroll_run:run-7:post");
  });

  it("records a failure that is not an AdapterRejection at all", async () => {
    /*
      A driver error, a bug in the kernel, a timeout. Those are the ones most
      worth having a durable record of, and an audit that only understood the
      adapter's own vocabulary would miss every one.
    */
    const { service, recorded } = serviceThatFails(new Error("connection terminated"));

    await expect(service.submit("org-1", "user-1", COMMAND, {} as never)).rejects.toThrow(
      "connection terminated",
    );

    expect(recorded[0]!.metadata?.code).toBe("UNEXPECTED");
    expect(recorded[0]!.metadata?.message).toBe("connection terminated");
  });

  it("does not record the honest opt-out", async () => {
    /*
      `BOOK_NOT_ENABLED` is raised on every posting attempt by every
      organisation that never enabled accounting. Auditing it would bury the
      real refusals under enormous volume — the failure mode of a log that
      records everything is the same as one that records nothing.
    */
    const { service, recorded } = serviceThatFails(
      new AdapterRejection("BOOK_NOT_ENABLED", "Accounting is not enabled"),
    );

    await expect(service.submit("org-1", "user-1", COMMAND, {} as never)).rejects.toThrow(
      AdapterRejection,
    );
    expect(recorded).toEqual([]);
  });

  it("names a system actor when nobody was on the other end", async () => {
    /*
      A payroll lock from a sweep and an outbox redelivery both post with no
      user. `audit_logs` makes the actor a union rather than a nullable id
      precisely so "nobody acted" cannot be confused with "an actor was lost".
    */
    const { service, recorded } = serviceThatFails(
      new AdapterRejection("UNBALANCED_COMMAND", "does not balance"),
    );

    await expect(service.submit("org-1", null, COMMAND, {} as never)).rejects.toThrow(
      AdapterRejection,
    );
    expect(recorded[0]!.systemActor).toBe("accounting-adapter:payroll_run");
    expect(recorded[0]!.userId).toBeUndefined();
  });

  it("still delivers the original rejection when the audit itself fails", async () => {
    /*
      The rejection is the signal the caller needs. Swapping "this book has no
      account tagged net_pay_clearing" for "audit table unavailable" would turn
      an actionable message into an unactionable one, and would make an audit
      outage look like an accounting misconfiguration.
    */
    const rejection = new AdapterRejection("UNKNOWN_ACCOUNT_TAG", "no such role");
    const { service } = serviceThatFails(rejection, { auditThrows: true });

    await expect(service.submit("org-1", "user-1", COMMAND, {} as never)).rejects.toThrow(
      "no such role",
    );
  });
});

describe("the idempotency key every caller depends on", () => {
  function serviceCapturingTheKey() {
    const posted: Array<{ idempotencyKey: string; lines: unknown[] }> = [];
    const ledger = {
      post: async (_org: string, _user: unknown, command: { idempotencyKey: string; lines: unknown[] }) => {
        posted.push(command);
        return { id: "j-1", journalNumber: "JV-1", replayed: false };
      },
    } as never;
    const books = {
      findDefault: async () => ({ id: "book-1", baseCurrency: "INR" }),
      /* Tag resolution is the kernel's; here it only has to succeed. */
      resolveAccountsByTag: async (_book: string, tags: string[]) =>
        new Map(tags.map((tag) => [tag, `acc-${tag}`])),
    } as never;
    const audit = { logCriticalOutsideTransaction: async () => undefined } as never;
    return { service: new PostingCommandService({} as never, books, ledger, audit), posted };
  }

  it("is {sourceType}:{sourceId}:{purpose}, so a redelivery is a no-op", async () => {
    const { service, posted } = serviceCapturingTheKey();
    await service.submit("org-1", "user-1", COMMAND, {} as never);
    expect(posted[0]!.idempotencyKey).toBe("payroll_run:run-7:post");
  });

  it("gives a payroll run's debits and credits from one signed amount", async () => {
    /*
      Payroll thinks in "salary expense 500,000, PF payable 60,000, net pay
      440,000" and should not have to think in debits and credits to hand that
      over. Positive debits, negative credits — and getting the sign convention
      backwards here would post every payroll upside down while balancing
      perfectly, which no balance check could catch.
    */
    const { service, posted } = serviceCapturingTheKey();

    await service.submitPayrollRun(
      "org-1",
      "user-1",
      {
        runId: "run-7",
        postingDate: "2026-09-30",
        currency: "INR",
        lines: [
          { tag: "salary", amountMinor: 50_000_00 },
          { tag: "net_pay_clearing", amountMinor: -44_000_00 },
          { tag: "statutory_payable", amountMinor: -6_000_00 },
        ],
      },
      {} as never,
    );

    expect(posted[0]!.lines).toEqual([
      expect.objectContaining({ debitMinor: 5_000_000, creditMinor: undefined }),
      expect.objectContaining({ creditMinor: 4_400_000, debitMinor: undefined }),
      expect.objectContaining({ creditMinor: 600_000, debitMinor: undefined }),
    ]);
  });

  it("reverses onto its own key, so a repeated reversal is a replay", async () => {
    /*
      `:reverse` rather than the original purpose. Reusing the original key
      would make the reversal collide with the posting it reverses; a key of
      its own makes a second reversal attempt return the first reversal instead
      of writing a second one.
    */
    const source = readFileSync(join(__dirname, "posting-command.service.ts"), "utf8");
    expect(source).toContain("`${source.sourceType}:${source.sourceId}:reverse`");
  });
});

describe("what this pack could not fix", () => {
  it("records that payroll still swallows its paid-posting failures", () => {
    /*
      Not a passing grade — a marker. If payroll ever stops swallowing, this
      test fails and whoever fixed it can delete it, which is the cheapest way
      to keep a known gap from being quietly forgotten. Fixing it here would
      mean editing payroll business logic, which the orchestrator's fence
      forbids this pack.
    */
    const payroll = readFileSync(
      join(__dirname, "../../..", "modules/payroll/payroll-posting.service.ts"),
      "utf8",
    );
    const at = payroll.indexOf("Payroll paid ledger posting failed");
    expect(at).toBeGreaterThan(-1);

    /*
      The shape of the problem: the catch around the paid posting inspects no
      code, so every rejection is treated as the opt-out. Read as the span from
      the `catch` that precedes the log line to the log line itself, rather
      than a fixed window, so an edit above it cannot make this pass by moving
      unrelated text into view.
    */
    const catchAt = payroll.lastIndexOf("} catch", at);
    const theCatch = payroll.slice(catchAt, at + 40);
    expect(theCatch).toContain("catch");
    expect(theCatch).not.toContain(".code ===");
    expect(theCatch).not.toContain("throw");
  });
});
