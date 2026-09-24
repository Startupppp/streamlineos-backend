import {
  summariseVaultErasure,
  type ObjectErasureOutcome,
} from "./candidate-vault-erasure";

describe("summariseVaultErasure — 'cleared' and 'not confirmed' are different answers", () => {
  /**
   * The whole point of the type. Reporting a candidate as erased while their
   * résumé is still in a bucket is a false statement to the person who asked to
   * be forgotten and a false record for a regulator.
   */
  it("reports CLEARED only when every object was observed to be deleted", () => {
    const summary = summariseVaultErasure(["DELETED", "DELETED", "DELETED"]);

    expect(summary.vault).toBe("CLEARED");
    expect(summary.objectsDeleted).toBe(3);
  });

  it("reports CLEARED for a candidate who had no vault objects at all", () => {
    const summary = summariseVaultErasure([]);

    expect(summary.vault).toBe("CLEARED");
    expect(summary.objectsDeleted).toBe(0);
    expect(summary.reason).toContain("no documents");
  });

  /**
   * One survivor denies the whole claim. "Mostly deleted" is the kind of
   * summary that gets read as "deleted".
   */
  it("refuses to report CLEARED when a single object could not be deleted", () => {
    const summary = summariseVaultErasure(["DELETED", "DELETED", "RETRY_PENDING"]);

    expect(summary.vault).toBe("NOT_CONFIRMED");
    if (summary.vault !== "NOT_CONFIRMED") throw new Error("expected NOT_CONFIRMED");
    expect(summary.objectsDeleted).toBe(2);
    expect(summary.objectsPendingRetry).toBe(1);
    expect(summary.objectsLost).toBe(0);
    expect(summary.reason).toContain("NOT confirmed");
  });

  /**
   * A lost object has no retry behind it, so the message must send a human to
   * the bucket rather than implying the sweep will handle it.
   */
  it("distinguishes an object queued for retry from one that is lost entirely", () => {
    const retry = summariseVaultErasure(["RETRY_PENDING"]);
    const lost = summariseVaultErasure(["LOST"]);

    if (retry.vault !== "NOT_CONFIRMED") throw new Error("expected NOT_CONFIRMED");
    if (lost.vault !== "NOT_CONFIRMED") throw new Error("expected NOT_CONFIRMED");

    // The retryable one promises the sweep will come back for it.
    expect(retry.reason).toContain("queued for retry by the storage sweep");
    expect(retry.reason).not.toContain("by hand");
    expect(retry.objectsPendingRetry).toBe(1);
    expect(retry.objectsLost).toBe(0);

    // The lost one has no retry behind it and must send a human to the bucket.
    expect(lost.reason).toContain("could not be queued for retry");
    expect(lost.reason).toContain("by hand");
    expect(lost.objectsPendingRetry).toBe(0);
    expect(lost.objectsLost).toBe(1);
  });

  it("counts every outcome kind when several fail in different ways", () => {
    const outcomes: ObjectErasureOutcome[] = ["DELETED", "RETRY_PENDING", "LOST", "LOST"];
    const summary = summariseVaultErasure(outcomes);

    expect(summary.vault).toBe("NOT_CONFIRMED");
    if (summary.vault !== "NOT_CONFIRMED") throw new Error("expected NOT_CONFIRMED");
    expect(summary.objectsDeleted).toBe(1);
    expect(summary.objectsPendingRetry).toBe(1);
    expect(summary.objectsLost).toBe(2);
  });
});
