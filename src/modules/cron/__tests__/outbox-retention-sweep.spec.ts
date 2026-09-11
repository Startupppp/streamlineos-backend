import { runBatchedDelete } from "../cron-outbox-retention.service";

describe("runBatchedDelete — batching contract", () => {
  it("stops after the first underfull batch, signalling no more eligible rows remain", async () => {
    let calls = 0;
    const result = await runBatchedDelete(
      async (limit) => { calls++; return limit - 1; },
      () => undefined,
    );
    expect(calls).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("fires onCapped and reports truncated=true when every batch is full", async () => {
    let capped = false;
    let calls = 0;
    const result = await runBatchedDelete(
      async (limit) => { calls++; return limit; },
      () => { capped = true; },
    );
    expect(result.truncated).toBe(true);
    expect(capped).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });
});
