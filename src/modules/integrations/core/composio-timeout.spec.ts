import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Box 7, provider limits — the mail path.
 *
 * `ComposioConfig` (SDK 0.14.0) has no timeout key, and the `@composio/client`
 * it constructs defaults to 60 s per request with `maxRetries: 2`, so one
 * unresponsive Composio call held a request for up to ~180 s plus backoff —
 * past the 30 s `statement_timeout` bounding the transaction around it. The
 * per-call `ComposioRequestOptions` accepts an `AbortSignal`; that is the only
 * lever the SDK gives, so every SDK call has to pass one and the risk is that
 * the next call added forgets.
 */
describe("ComposioGateway outbound deadlines", () => {
  const SOURCE = readFileSync(join(__dirname, "composio.gateway.ts"), "utf8");

  const SDK_CALL = /(?:this\.getClient\(\)|client)\.(connectedAccounts|tools|toolkits)\.(\w+)\(/g;

  it("mints a fresh deadline per call rather than one shared signal", () => {
    expect(SOURCE).toContain("signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS)");
    expect(SOURCE).toMatch(/private requestOptions\(\): \{ signal: AbortSignal \}/);
  });

  it("passes the deadline to every Composio SDK call", () => {
    const calls = [...SOURCE.matchAll(SDK_CALL)];
    expect(calls.length).toBeGreaterThanOrEqual(7);

    const undeadlined: string[] = [];
    for (const call of calls) {
      const start = call.index;
      const argumentText = SOURCE.slice(start, SOURCE.indexOf(";", start));
      if (!argumentText.includes("this.requestOptions()"))
        undeadlined.push(`${call[1]}.${call[2]}`);
    }

    expect(undeadlined).toEqual([]);
  });

  it("keeps the deadline inside the request budget the transaction guard allows", () => {
    const declared = /COMPOSIO_REQUEST_TIMEOUT_MS = ([\d_]+)/.exec(SOURCE)?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared?.replace(/_/g, ""))).toBeLessThan(30_000);
  });
});
