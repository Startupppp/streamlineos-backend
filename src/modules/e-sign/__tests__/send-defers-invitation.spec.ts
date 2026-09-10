import { SignEnvelopeDispatchService } from "../sign-envelope-dispatch.service";
import {
  runWithTenantContext,
  type AfterCommitHook,
} from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";

/*
 * The transaction boundary is the subject, so nothing here may fake it away.
 *
 * `db.transaction` really opens and closes, and every notification double
 * records whether it was open at the moment the "email" left. An assertion on
 * call counts alone would pass just as happily with the send back inside the
 * transaction, which is the bug this file exists to keep out.
 */
/**
 * Stands in for the request transaction `TenantContextInterceptor` holds open
 * around the whole handler. It is the one that matters: `this.db` is the
 * tenant-aware proxy, so the service's own `db.transaction` is merely a
 * SAVEPOINT inside this, and "after the inner block" is still very much inside
 * the transaction holding the pooled connection.
 */
let enclosingTxOpen = false;

const ORG = "org-sign-defer";
const USER = "user-sender";
const ENVELOPE = 77;

interface SentEmail {
  to: string;
  kind: "invitation" | "cc";
  /** Was *any* transaction open — enclosing or inner — when this left? */
  txOpen: boolean;
}

function makeHarness(opts: { ccTiming?: string } = {}) {
  let txDepth = 0;
  const sent: SentEmail[] = [];

  const envelopeRow = {
    id: ENVELOPE,
    orgId: ORG,
    status: "draft",
    routingMode: "parallel",
    title: "Mutual NDA",
    message: "Please countersign.",
    ccTiming: opts.ccTiming ?? "none",
    expiresAt: null,
    senderUserId: USER,
  };

  const noop = { returning: async () => [envelopeRow] };
  const tx = {
    update: () => ({ set: () => ({ where: () => Object.assign(Promise.resolve([envelopeRow]), noop) }) }),
    insert: () => ({ values: async () => [] }),
  };

  const db = {
    query: {
      signEnvelopes: { findFirst: async () => envelopeRow },
      users: { findFirst: async () => ({ id: USER, name: "Dana Sender" }) },
    },
    transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      txDepth += 1;
      try {
        return await fn(tx);
      } finally {
        txDepth -= 1;
      }
    },
  };

  const recipientRows = [
    { id: 1, recipientType: "signer", routingOrder: 1, status: "pending", email: "signer@example.com", name: "Sam Signer" },
    { id: 2, recipientType: "cc", routingOrder: 1, status: "pending", email: "watcher@example.com", name: "Wes Watcher" },
  ];

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
  const service = new SignEnvelopeDispatchService(
    db as unknown as Db,
    { record: jest.fn() } as never,
    {
      generateSigningToken: jest.fn(() => `raw-token-${(counter += 1)}`),
      hash: jest.fn((t: string) => `hash-of-${t}`),
      buildSigningUrl: jest.fn((t: string) => `https://app.example.com/sign/${t}`),
    } as never,
    { getOrCreate: jest.fn(async () => ({ defaultExpirationDays: 14 })) } as never,
    notifications as never,
    { listForEnvelope: jest.fn(async () => recipientRows) } as never,
    { emitEnvelopeEvent: jest.fn() } as never,
    { validate: jest.fn(async () => ({ valid: true, errors: [] })) } as never,
  );

  return { service, sent, notifications };
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

describe("send does not email from inside the enclosing transaction", () => {
  beforeEach(() => {
    enclosingTxOpen = false;
  });

  it("defers every email past the transaction when the request context can hold a hook", async () => {
    const h = makeHarness({ ccTiming: "on_send" });

    const { drain } = await underRequestContext(() =>
      h.service.send(ORG, ENVELOPE, { orgId: ORG, userId: USER }),
    );

    /*
     * The load-bearing assertion. `this.db` is the tenant-aware proxy, so the
     * service's own `db.transaction` is only a SAVEPOINT under a live request
     * transaction — sending here held a pooled connection across SMTP, and a
     * throw rolled the committed-looking "sent" flip back underneath mail that
     * had already landed.
     */
    expect(h.sent).toEqual([]);

    await drain();

    expect(h.sent).toEqual([
      { to: "signer@example.com", kind: "invitation", txOpen: false },
      { to: "watcher@example.com", kind: "cc", txOpen: false },
    ]);
  });

  it("still sends, inline, when the ambient context carries no hook array", async () => {
    /*
     * Bulk send's shape. `runInNewTenantTransaction` builds its context without
     * an `afterCommit` array, so `registerAfterCommit` returns false there — and
     * §4 says fall back to running inline rather than dropping the work. If this
     * ever regresses to a silent no-op, every bulk-send invitation disappears
     * while the job still reports success.
     */
    const h = makeHarness();

    await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: {} as TenantTx },
      () => h.service.send(ORG, ENVELOPE, { orgId: ORG, userId: USER }),
    );

    expect(h.sent).toEqual([
      { to: "signer@example.com", kind: "invitation", txOpen: false },
    ]);
  });

  it("sends inline when there is no ambient context at all", async () => {
    const h = makeHarness();

    await h.service.send(ORG, ENVELOPE, { orgId: ORG, userId: USER });

    expect(h.notifications.sendInvitation).toHaveBeenCalledTimes(1);
    expect(h.sent[0]).toMatchObject({ to: "signer@example.com", txOpen: false });
  });

  it("pins why bulk send cannot defer: runInNewTenantTransaction builds no hook array", async () => {
    /*
     * Read straight off the real function rather than asserted from the source,
     * because the whole fallback above hangs on it. `registerAfterCommit` keys
     * on the array's presence, not the context's — a context is very much
     * present here.
     */
    const { getTenantContext } = await import("../../../common/tenant/tenant-context");
    const db = {
      transaction: async <T>(fn: (t: unknown) => Promise<T>) => fn({ execute: async () => [] }),
      execute: async () => [],
      query: {},
    };

    const seen = await runInNewTenantTransaction(db as unknown as Db, ORG, async () => {
      const ctx = getTenantContext();
      return { hasContext: Boolean(ctx), hasHookArray: Boolean(ctx?.afterCommit) };
    });

    expect(seen).toEqual({ hasContext: true, hasHookArray: false });
  });
});
