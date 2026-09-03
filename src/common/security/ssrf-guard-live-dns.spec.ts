/**
 * The SSRF guard, exercised against the REAL `node:dns` resolver.
 *
 * This file used to live at `src/modules/build/core/webhook-url-guard.spec.ts`,
 * next to a one-line re-export shim. Commit 7c938419 deleted the shim and
 * re-pointed its callers at `common/security/ssrf-guard` directly, which left a
 * spec named after a file that no longer exists, parked in a module that no
 * longer owns any SSRF code. It was never dead — it always imported the shared
 * implementation — so it is re-pointed here rather than deleted.
 *
 * It is deliberately kept SEPARATE from `ssrf-guard.spec.ts`, which calls
 * `jest.mock("node:dns/promises")` at module scope and therefore can never
 * execute the resolver path at all. A guard that stopped calling `lookup`, or
 * that swallowed a resolver rejection into `{ allowed: true }`, would pass every
 * assertion in that file. Only an unmocked run can see it, and only these
 * assertions do.
 */

import { checkWebhookUrl } from "./ssrf-guard";

describe("checkWebhookUrl — against the real resolver", () => {
  it("rejects a malformed url", async () => {
    await expect(checkWebhookUrl("not a url")).resolves.toEqual({
      allowed: false,
      reason: "invalid-url",
    });
  });

  it.each(["file:///etc/passwd", "gopher://example.com", "ftp://example.com"])(
    "rejects non-http scheme %s",
    async (url) => {
      await expect(checkWebhookUrl(url)).resolves.toEqual({
        allowed: false,
        reason: "unsupported-scheme",
      });
    },
  );

  it.each([
    ["loopback", "http://127.0.0.1/hook"],
    ["loopback alt", "http://127.10.20.30/hook"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private 10/8", "http://10.0.0.5/hook"],
    ["private 172.16/12", "http://172.20.1.1/hook"],
    ["private 192.168/16", "http://192.168.1.1/hook"],
    ["carrier-grade NAT", "http://100.64.0.1/hook"],
    ["this-network", "http://0.0.0.0/hook"],
    ["multicast", "http://239.1.1.1/hook"],
    ["ipv6 loopback", "http://[::1]/hook"],
    ["ipv6 link-local", "http://[fe80::1]/hook"],
    ["ipv6 unique-local", "http://[fd00::1]/hook"],
    ["ipv4-mapped loopback", "http://[::ffff:127.0.0.1]/hook"],
  ])("blocks %s", async (_label, url) => {
    await expect(checkWebhookUrl(url)).resolves.toEqual({
      allowed: false,
      reason: "blocked-address",
    });
  });

  it("allows a public literal address", async () => {
    await expect(checkWebhookUrl("https://93.184.216.34/hook")).resolves.toEqual({
      allowed: true,
    });
  });

  /**
   * `.invalid` is reserved by RFC 2606 and can never resolve, so this reaches
   * the real `lookup` and asserts the rejection is turned into a denial rather
   * than propagating or defaulting to allow.
   */
  it("rejects a hostname that does not resolve", async () => {
    const result = await checkWebhookUrl("https://webhook-guard-nonexistent.invalid/hook");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(["unresolvable-host", "blocked-address"]).toContain(result.reason);
    }
  });
});
