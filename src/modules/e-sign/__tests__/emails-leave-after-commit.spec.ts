import { SignEnvelopeDispatchService } from "../sign-envelope-dispatch.service";
import { SignEnvelopeInvitationsService } from "../sign-envelope-invitations.service";
import { withRecipientSession } from "../lib/recipient-session";
import {
  registerAfterCommit,
  runWithTenantContext,
  type AfterCommitHook,
} from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { observeAfterCommitWork } from "../../../common/observability/after-commit-work";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../common/tenant/with-tenant";

/*
 * The transaction boundary is the subject, so nothing here may fake it away.
 *
 * `db.transaction` really opens and closes, and every notification double
 * records whether a transaction was open at the moment the "email" left. An
 * assertion on call counts alone would pass just as happily with the send back
 * inside the transaction, which is the bug this file exists to keep out.
 */
const ORG = "org-sign-defer";
const USER = "user-sender";
const MEMBERSHIP = 501;
const ENVELOPE = 77;

/**
 * Stands in for the request transaction `TenantContextInterceptor` holds open
 * around the whole handler. It is the one that matters: `this.db` is the
 * tenant-aware proxy, so a service's own `db.transaction` is merely a SAVEPOINT
 * inside this, and "after the inner block" is still very much inside the
 * transaction holding the pooled connection.
 */
let enclosingTxOpen = false;

interface SentEmail {
  to: string;
  kind: "invitation" | "cc";
  /** Was *any* transaction open — enclosing or inner — when this left? */
  txOpen: boolean;
}

interface Recipient {
  id: number;
  recipientType: string;
  routingOrder: number;
  status: string;
  email: string | null;
  name: string;
}

const SIGNER: Recipient = {
  id: 1,
  recipientType: "signer",
  routingOrder: 1,
  status: "pending",
  email: "signer@example.com",
  name: "Sam Signer",
};
const WATCHER: Recipient = {
  id: 2,
  recipientType: "cc",
  routingOrder: 1,
  status: "pending",
  email: "watcher@example.com",
  name: "Wes Watcher",
};

const ACTOR = { orgId: ORG, userId: USER, membershipId: MEMBERSHIP };

function makeHarness(
  opts: {
    ccTiming?: string;
    status?: string;
    routingMode?: string;
    recipients?: Recipient[];
  } = {},
) {
  let txDepth = 0;
  const sent: SentEmail[] = [];

  const envelopeRow = {
    id: ENVELOPE,
    orgId: ORG,
    status: opts.status ?? "draft",
    routingMode: opts.routingMode ?? "parallel",
    title: "Mutual NDA",
    message: "Please countersign.",
    ccTiming: opts.ccTiming ?? "none",
    expiresAt: null,
    senderMembershipId: MEMBERSHIP,
  };

  const written: Record<string, unknown>[] = [];
  const writeBuilder = {
    set: (patch: Record<string, unknown>) => ({
      where: () => {
        written.push(patch);
        const done = Promise.resolve([envelopeRow]);
        return Object.assign(done, { returning: async () => [envelopeRow] });
      },
    }),
  };

  const tx = {
    update: () => writeBuilder,
    insert: () => ({ values: async () => [] }),
  };

  const db = {
    query: {
      signEnvelopes: { findFirst: async () => envelopeRow },
      organizationMembers: {
        findFirst: async () => ({ id: MEMBERSHIP, user: { name: "Dana Sender" } }),
      },
    },
    update: () => writeBuilder,
    transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      txDepth += 1;
      try {
        return await fn(tx);
      } finally {
        txDepth -= 1;
      }
    },
  };

  const recipientRows = opts.recipients ?? [SIGNER, WATCHER];

  const inAnyTx = () => txDepth > 0 || enclosingTxOpen;
  const notifications = {
    sendInvitation: jest.fn(async (to: string) => {
      sent.push({ to, kind: "invitation", txOpen: inAnyTx() });
    }),
    sendCcNotice: jest.fn(async (to: string) => {
      sent.push({ to, kind: "cc", txOpen: inAnyTx() });
    }),
  };

  let counter = 0;
  const tokens = {
    generateSigningToken: jest.fn(() => `raw-token-${(counter += 1)}`),
    hash: jest.fn((t: string) => `hash-of-${t}`),
    buildSigningUrl: jest.fn((t: string) => `https://app.example.com/sign/${t}`),
  };
  const service = new SignEnvelopeDispatchService(
    db as unknown as Db,
    { record: jest.fn() } as never,
    tokens as never,
    { getOrCreate: jest.fn(async () => ({ defaultExpirationDays: 14 })) } as never,
    notifications as never,
    { listForEnvelope: jest.fn(async () => recipientRows) } as never,
    { emitEnvelopeEvent: jest.fn() } as never,
    { validate: jest.fn(async () => ({ valid: true, errors: [] })) } as never,
    new SignEnvelopeInvitationsService(tokens as never, notifications as never),
  );

  return { service, sent, notifications, written };
}

/** The context `TenantContextInterceptor` builds: a transaction *and* a hook array. */
async function underRequestContext<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; drain: () => Promise<void> }> {
  const afterCommit: AfterCommitHook[] = [];
  enclosingTxOpen = true;
  let result: T;
  try {
    result = await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: {} as TenantTx, afterCommit },
      fn,
    );
  } finally {
    // The interceptor drains hooks only after `withTenant` has committed.
    enclosingTxOpen = false;
  }
  return {
    result,
    drain: async () => {
      for (const hook of afterCommit) await hook();
    },
  };
}

/** A transaction and no hook array — the context `forEachOrg` builds for each organisation. */
function underHooklessContext<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx: {} as TenantTx }, fn);
}

beforeEach(() => {
  enclosingTxOpen = false;
});

describe("send does not email from inside the enclosing transaction", () => {
  it("defers every email past the transaction when the request context can hold a hook", async () => {
    const h = makeHarness({ ccTiming: "on_send" });

    const { drain } = await underRequestContext(() => h.service.send(ORG, ENVELOPE, ACTOR));

    /*
     * The load-bearing assertion. `this.db` is the tenant-aware proxy, so the
     * service's own `db.transaction` is only a SAVEPOINT under a live request
     * transaction — sending here held a pooled connection across SMTP, and a
     * throw rolled the committed-looking "sent" flip back underneath mail that
     * had already landed.
     */
    expect(h.sent).toEqual([]);

    await drain();

    // Signers before watchers: two hooks, drained in registration order.
    expect(h.sent).toEqual([
      { to: "signer@example.com", kind: "invitation", txOpen: false },
      { to: "watcher@example.com", kind: "cc", txOpen: false },
    ]);
  });

  it("still sends, inline, when the ambient context carries no hook array", async () => {
    /*
     * A context built without an `afterCommit` array — `forEachOrg`'s per-org
     * sweep context is one — makes `registerAfterCommit` return false, and §4
     * says fall back to running inline rather than dropping the work. If this
     * ever regresses to a silent no-op, every invitation sent from such a
     * context disappears while the caller still reports success.
     */
    const h = makeHarness();

    await underHooklessContext(() => h.service.send(ORG, ENVELOPE, ACTOR));

    expect(h.sent).toEqual([
      { to: "signer@example.com", kind: "invitation", txOpen: false },
    ]);
  });

  it("sends inline when there is no ambient context at all", async () => {
    const h = makeHarness();

    await h.service.send(ORG, ENVELOPE, ACTOR);

    expect(h.notifications.sendInvitation).toHaveBeenCalledTimes(1);
    expect(h.sent[0]).toMatchObject({ to: "signer@example.com", txOpen: false });
  });
});

describe("resend does not email from inside the enclosing transaction", () => {
  const invited: Recipient = { ...SIGNER, status: "invited" };

  it("rotates the token inside the transaction and mails outside it", async () => {
    const h = makeHarness({ status: "sent", recipients: [invited] });

    const { result, drain } = await underRequestContext(() =>
      h.service.resend(ORG, ENVELOPE, ACTOR),
    );

    /*
     * The rotation is a database write that must be atomic with the request, so
     * it stays inside; the mail is a network call, so it does not. Rotating
     * already invalidated the link the recipient held, which is what makes a
     * lost hook recoverable: another resend mints another token.
     */
    expect(h.written).toEqual([
      { signingTokenHash: "hash-of-raw-token-1", tokenRevokedAt: null },
    ]);
    expect(h.sent).toEqual([]);

    await drain();

    expect(h.sent).toEqual([
      { to: "signer@example.com", kind: "invitation", txOpen: false },
    ]);
    // Counted from rotations, so the number is the same either way.
    expect(result).toEqual({ resentCount: 1 });
  });

  it("still sends, inline, when the ambient context carries no hook array", async () => {
    const h = makeHarness({ status: "sent", recipients: [invited] });

    const result = await underHooklessContext(() => h.service.resend(ORG, ENVELOPE, ACTOR));

    expect(h.sent).toEqual([
      { to: "signer@example.com", kind: "invitation", txOpen: false },
    ]);
    expect(result).toEqual({ resentCount: 1 });
  });
});

describe("applyRecipientOutcome does not email from inside the enclosing transaction", () => {
  /*
   * Sequential routing, the first signer done and the second still waiting —
   * the auto-advance branch, which is the only place this method sends mail.
   * The envelope already reads `partially_completed`, so the status write is a
   * no-op and the branch under test is reached directly.
   */
  const done: Recipient = { ...SIGNER, id: 1, status: "completed", routingOrder: 1 };
  const next: Recipient = {
    id: 2,
    recipientType: "signer",
    routingOrder: 2,
    status: "pending",
    email: "next@example.com",
    name: "Nia Next",
  };
  const sequential = {
    status: "partially_completed",
    routingMode: "sequential",
    recipients: [done, next],
  };

  it("marks the next recipient invited inside the transaction and mails outside it", async () => {
    const h = makeHarness(sequential);

    const { result, drain } = await underRequestContext(() =>
      h.service.applyRecipientOutcome(ORG, ENVELOPE),
    );

    expect(h.written).toEqual([
      {
        status: "invited",
        signingTokenHash: "hash-of-raw-token-1",
        tokenExpiresAt: null,
      },
    ]);
    expect(h.sent).toEqual([]);

    await drain();

    expect(h.sent).toEqual([
      { to: "next@example.com", kind: "invitation", txOpen: false },
    ]);
    expect(result.status).toBe("partially_completed");
  });

  it("still sends, inline, when the ambient context carries no hook array", async () => {
    const h = makeHarness(sequential);

    await underHooklessContext(() => h.service.applyRecipientOutcome(ORG, ENVELOPE));

    expect(h.sent).toEqual([
      { to: "next@example.com", kind: "invitation", txOpen: false },
    ]);
  });
});

describe("the transaction seams decide whether a hook can be held at all", () => {
  it("runInNewTenantTransaction holds hooks and drains them after its own commit", async () => {
    /*
     * Read straight off the real function rather than asserted from the source.
     *
     * Every fresh tenant context now carries an `afterCommit` array: a hookless
     * one made `registerAfterCommit` answer false, and callers that ignored the
     * answer lost the work. So bulk send, which reaches `send` one row at a
     * time inside `runInNewTenantTransaction`, defers its email past that row's
     * commit rather than sending it inline. What has to hold is the order — the
     * hook runs only once the transaction that registered it has closed, and
     * in a transaction of its own.
     */
    const { getTenantContext } = await import("../../../common/tenant/tenant-context");
    const log: string[] = [];
    let txSeq = 0;
    const db = {
      transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
        const id = (txSeq += 1);
        log.push(`tx${id}-open`);
        try {
          return await fn({ execute: async () => [] });
        } finally {
          log.push(`tx${id}-close`);
        }
      },
      execute: async () => [],
      query: {},
    };
    const drains: Promise<unknown>[] = [];
    const stopObserving = observeAfterCommitWork((completion) => drains.push(completion));

    try {
      const seen = await runInNewTenantTransaction(db as unknown as Db, ORG, async () => {
        const ctx = getTenantContext();
        const deferred = registerAfterCommit(async () => {
          log.push("hook");
        });
        log.push("body");
        return { hasContext: Boolean(ctx), hasHookArray: Boolean(ctx?.afterCommit), deferred };
      });
      await Promise.all(drains);

      expect(seen).toEqual({ hasContext: true, hasHookArray: true, deferred: true });
      expect(log).toEqual(["tx1-open", "body", "tx1-close", "tx2-open", "hook", "tx2-close"]);
    } finally {
      stopObserving();
    }
  });

  it("a public signing session holds hooks and drains them after its transaction", async () => {
    /*
     * The reason `applyRecipientOutcome` can defer at all.
     *
     * Every public signing route is `@Public()`, so no ambient context exists
     * and the transaction `withRecipientSession` opens is the outermost one.
     * `runInTenantTransaction` builds that context with no hook array, so
     * without the queue the session installs, `registerAfterCommit` would
     * return false on the *only* path that reaches `applyRecipientOutcome` and
     * the deferral there would be decoration over an unchanged send.
     */
    const log: string[] = [];
    let txSeq = 0;
    const recipient = { id: 1, orgId: ORG, envelopeId: ENVELOPE, signingTokenHash: "hash-of-tok" };

    const db = {
      transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
        const id = (txSeq += 1);
        log.push(`tx${id}-open`);
        try {
          return await fn({
            execute: async () => [],
            query: {
              signRecipients: { findFirst: async () => recipient },
              signEnvelopes: { findFirst: async () => ({ id: ENVELOPE, orgId: ORG }) },
            },
          });
        } finally {
          log.push(`tx${id}-close`);
        }
      },
    };

    let deferred: boolean | null = null;

    // `withRecipientSession` moved to lib/recipient-session.ts when
    // sign-public.service.ts was split, so this calls it directly instead of
    // casting a constructed service to reach a private method. Same function,
    // same seam — and the cast this used to need was itself a hint that the
    // behaviour under test never depended on the class.
    await withRecipientSession(
      db as unknown as Db,
      { hash: jest.fn(() => "hash-of-tok") } as never,
      { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as never,
      "tok",
      async () => {
        log.push("body");
        deferred = registerAfterCommit(async () => {
          log.push("hook");
        });
        return null;
      },
    );

    expect(deferred).toBe(true);
    expect(log).toEqual([
      // withPublicToken resolves the recipient on its own connection
      "tx1-open",
      "tx1-close",
      // the session transaction: the body runs, and nothing is mailed in it
      "tx2-open",
      "body",
      "tx2-close",
      // and only then the hook, in a transaction of its own
      "tx3-open",
      "hook",
      "tx3-close",
    ]);
  });
});

describe("reviving an expired envelope's recipients", () => {
  const EXPIRED_SIGNER: Recipient & { completedAt: null } = {
    ...SIGNER,
    status: "expired",
    completedAt: null,
  };
  const DONE_SIGNER: Recipient & { completedAt: string } = {
    id: 3,
    recipientType: "signer",
    routingOrder: 1,
    status: "completed",
    email: "done@example.com",
    name: "Dee Done",
    completedAt: "2026-06-01T00:00:00.000Z",
  };
  const PENDING_SIGNER: Recipient & { completedAt: null } = {
    id: 4,
    recipientType: "signer",
    routingOrder: 2,
    status: "pending",
    email: "next@example.com",
    name: "Nia Next",
    completedAt: null,
  };

  it("re-invites only the recipients the sweep expired, after the commit, with a fresh token", async () => {
    const h = makeHarness({ status: "sent", recipients: [EXPIRED_SIGNER, DONE_SIGNER, PENDING_SIGNER] });
    const expiresAt = new Date("2999-01-01T00:00:00.000Z");

    const { result, drain } = await underRequestContext(() =>
      h.service.reviveExpiredRecipients(ORG, ENVELOPE, expiresAt, ACTOR),
    );

    expect(result).toBe(1);
    expect(h.sent).toHaveLength(0);
    const restored = h.written.find((w) => w["status"] === "invited");
    expect(restored).toMatchObject({ tokenRevokedAt: null, tokenExpiresAt: expiresAt });
    expect(restored?.["signingTokenHash"]).toMatch(/^hash-of-raw-token-/);

    await drain();

    expect(h.sent).toEqual([{ to: EXPIRED_SIGNER.email, kind: "invitation", txOpen: false }]);
  });

  it("does nothing when no recipient was expired", async () => {
    const h = makeHarness({ status: "sent", recipients: [DONE_SIGNER, PENDING_SIGNER] });

    const { result } = await underRequestContext(() =>
      h.service.reviveExpiredRecipients(ORG, ENVELOPE, new Date("2999-01-01T00:00:00.000Z"), ACTOR),
    );

    expect(result).toBe(0);
    expect(h.written).toHaveLength(0);
  });
});
