import { resolveSafeWebhookTarget } from "../security/ssrf-guard";
import { pinnedLookup } from "./safe-webhook-transport";

describe("safe webhook DNS pinning", () => {
  it("pins the validated address so a later DNS rebind cannot change the socket target", async () => {
    let dnsAnswer = "93.184.216.34";
    const resolver = jest.fn(async () => [{ address: dnsAnswer, family: 4 }]);
    const target = await resolveSafeWebhookTarget("https://hooks.example.test/path", resolver);
    expect("reason" in target).toBe(false);
    if ("reason" in target) throw new Error(target.reason);

    dnsAnswer = "127.0.0.1";
    const lookup = pinnedLookup(target);
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("hooks.example.test", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects validation when any DNS answer is private", async () => {
    const target = await resolveSafeWebhookTarget(
      "https://hooks.example.test/path",
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    );
    expect(target).toEqual({ reason: "blocked-address" });
  });
});
