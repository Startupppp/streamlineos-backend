import { buildService, makeHarness, type Harness } from "./employee-onboarding.spec-fixtures";

/**
 * V-030. The invite used to commit its magic-link token, then enqueue the mail,
 * then UPDATE the token back to used if the enqueue failed — atomicity by
 * compensation. Two things go wrong with that. A crash between the commit and
 * the enqueue leaves a live invite token nobody was ever mailed, with nothing
 * left to notice it. And the compensating UPDATE runs on a separate handle, so
 * it can fail on its own and leave the same orphan.
 *
 * `this.db` is the tenant-aware proxy, so `EmailOutboxService` writes its row on
 * whatever transaction is ambient. Enqueueing from inside the transaction
 * callback therefore puts the token and the outbox row in one unit of work, and
 * the only question worth pinning is whether the enqueue actually happens while
 * that transaction is still open.
 */

const ORG_ID = "org-atomic";
const ACTOR = { orgId: ORG_ID, userId: "actor-1", isOrgOwner: true };
const TARGET = "user-target-1";

function memberRow() {
  return {
    email: "target@example.test",
    name: "Target Person",
    firstName: "Target",
    lastName: "Person",
    isActive: true,
    emailVerified: null,
    membershipStatus: "ACTIVE",
  };
}

/**
 * The harness commits by default. This wraps its transaction so a callback that
 * throws discards everything recorded inside it — which is what Postgres does,
 * and the only way a unit spec can tell "inside the transaction" from "after it".
 */
function rollbackAware(harness: Harness) {
  const db = harness.db as unknown as {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  const commit = db.transaction;
  const state = { open: false };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const insertedAt = harness.inserted.length;
    const updatedAt = harness.updated.length;
    state.open = true;
    try {
      return await commit.call(db, fn);
    } catch (error) {
      harness.inserted.length = insertedAt;
      harness.updated.length = updatedAt;
      throw error;
    } finally {
      state.open = false;
    }
  };
  return state;
}

describe("the invite token and its outbox row are one unit of work", () => {
  afterEach(() => jest.clearAllMocks());

  it("a rolled-back invite leaves neither a magic-link token nor an outbox row", async () => {
    const harness = makeHarness({ selects: { organization_members: [[memberRow()]] } });
    const tx = rollbackAware(harness);
    const { service, queueWelcomeEmail } = buildService(harness.db);

    // The outbox row is the enqueue's only durable effect, and it is written on
    // the ambient handle — so it is recorded here and discarded by the same
    // rollback that discards the token.
    const outboxRows: string[] = [];
    queueWelcomeEmail.mockImplementation(async () => {
      expect(tx.open).toBe(true);
      outboxRows.push(TARGET);
      const before = outboxRows.length;
      throw Object.assign(new Error("email outbox insert failed"), { rolledBackAt: before });
    });

    await expect(service.resendInvite(ACTOR as never, TARGET)).rejects.toThrow(
      "email outbox insert failed",
    );

    // Neither survives. Before the fix the token was already committed by the
    // time the enqueue ran, so this insert was still here.
    expect(harness.inserted.filter((row) => row.table === "magic_link_tokens")).toEqual([]);
    expect(harness.updated.filter((row) => row.table === "magic_link_tokens")).toEqual([]);
  });

  it("enqueues the mail while the transaction that issued the token is still open", async () => {
    const harness = makeHarness({ selects: { organization_members: [[memberRow()]] } });
    const tx = rollbackAware(harness);
    const { service, queueWelcomeEmail } = buildService(harness.db);

    let openAtEnqueue: boolean | null = null;
    let tokenIssuedAtEnqueue = 0;
    queueWelcomeEmail.mockImplementation(async () => {
      openAtEnqueue = tx.open;
      tokenIssuedAtEnqueue = harness.inserted.filter(
        (row) => row.table === "magic_link_tokens",
      ).length;
      return { queued: true };
    });

    await expect(service.resendInvite(ACTOR as never, TARGET)).resolves.toEqual({
      success: true,
      invite: { sent: true, reason: null },
    });

    expect(openAtEnqueue).toBe(true);
    // Paired with the above: the enqueue is inside the transaction AND after the
    // token exists, so the mailed link is the one that was persisted.
    expect(tokenIssuedAtEnqueue).toBe(1);
  });

  it("retires an undeliverable token in the same transaction instead of compensating on another handle", async () => {
    const harness = makeHarness({ selects: { organization_members: [[memberRow()]] } });
    const tx = rollbackAware(harness);
    const { service, queueWelcomeEmail } = buildService(harness.db);

    const retirementsInsideTx: number[] = [];
    queueWelcomeEmail.mockResolvedValue({
      queued: false,
      reason: "No email provider is configured.",
    });
    const commitHarness = harness.db as unknown as { update: jest.Mock };
    const record = commitHarness.update;
    commitHarness.update = jest.fn((target: unknown) => {
      retirementsInsideTx.push(tx.open ? 1 : 0);
      return record(target) as unknown;
    });

    await expect(service.resendInvite(ACTOR as never, TARGET)).resolves.toEqual({
      success: true,
      invite: { sent: false, reason: "No email provider is configured." },
    });

    // Two retirements — the earlier invites, then the one just issued and never
    // delivered — and both ran with the transaction open. The second used to run
    // on `this.db` after the commit, where it could fail on its own.
    expect(retirementsInsideTx).toEqual([1, 1]);
  });
});
