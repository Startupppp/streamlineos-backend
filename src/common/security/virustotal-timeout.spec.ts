import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VirusTotalScanner } from "./virustotal-av-scanner";

/**
 * Box 7, provider limits: an unresponsive third party must not tie up a
 * connection indefinitely. Node's `fetch` has no default request timeout, so
 * these three requests were unbounded — a VirusTotal endpoint that accepts the
 * socket and never writes held the upload request until the socket died.
 *
 * Two assertions, because either alone is defeatable: the behavioural one
 * proves a deadline is carried and an abort is handled fail-closed, and the
 * source scan proves a fourth endpoint added later cannot reintroduce a bare
 * `fetch` beside the guarded helper.
 */
describe("VirusTotalScanner outbound deadlines", () => {
  const SOURCE = readFileSync(join(__dirname, "virustotal-av-scanner.ts"), "utf8");

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function captureSignals(): { signals: Array<AbortSignal | null | undefined> } {
    const captured: { signals: Array<AbortSignal | null | undefined> } = { signals: [] };
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured.signals.push(init?.signal);
      return Promise.reject(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    };
    return captured;
  }

  it("carries a live, unfired deadline on the hash-report request", async () => {
    const captured = captureSignals();
    const scanner = new VirusTotalScanner("test-key");

    await scanner.scan(Buffer.from("payload"), "f.bin", "application/octet-stream");

    expect(captured.signals).toHaveLength(1);
    const signal = captured.signals[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("fails closed rather than hanging when the provider aborts the request", async () => {
    captureSignals();
    const scanner = new VirusTotalScanner("test-key");

    const result = await scanner.scan(Buffer.from("payload"), "f.bin", "application/octet-stream");

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.reason).toContain("vt-api-error");
  });

  it("routes every outbound request through the deadline-carrying helper", () => {
    const callSites = SOURCE.match(/(?<!\.)\bfetch\(/g) ?? [];
    expect(callSites).toHaveLength(1);
    expect(SOURCE).toContain("signal: AbortSignal.timeout(timeoutMs)");

    /**
     * One guarded call, because the hash report is now the ONLY outbound
     * request: the file-submission and analysis-polling endpoints were deleted.
     * The count is not the guard on its own — `callSites` above is — so it moves
     * with the endpoint list rather than pinning a number.
     */
    const guardedCalls = SOURCE.match(/this\.vtFetch\(/g) ?? [];
    expect(guardedCalls).toHaveLength(1);
  });

  /**
   * The tenant-private guarantee, asserted on behaviour rather than on source:
   * a file VirusTotal has never seen must be refused, and nothing may leave this
   * process except the hash. A regression that restores the submission endpoint
   * fails here on the request count and the method before any source scan runs.
   */
  it("never sends the file body — an unknown hash is refused, not submitted", async () => {
    const requests: Array<{ url: string; method: string | undefined; hasBody: boolean }> = [];
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: String(input),
        method: init?.method,
        hasBody: init?.body !== undefined && init?.body !== null,
      });
      return Promise.resolve(new Response("{}", { status: 404 }));
    };

    const scanner = new VirusTotalScanner("test-key");
    const payload = Buffer.from("first-seen-tenant-payslip");
    const result = await scanner.scan(payload, "payslip.pdf", "application/pdf");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBeUndefined();
    expect(requests[0]?.hasBody).toBe(false);
    expect(requests[0]?.url).toContain(
      createHash("sha256").update(payload).digest("hex"),
    );
    expect(requests.some((r) => r.url.endsWith("/files"))).toBe(false);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.reason).toBe("vt-unknown-hash");
  });
});
