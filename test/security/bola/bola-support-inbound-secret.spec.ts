import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SupportChannelsService } from "../../../src/modules/support/core/support-channels.service";
import {
  generateInboundSecret,
  hashInboundSecret,
  inboundSecretMatches,
  isHashedInboundSecret,
} from "../../../src/modules/support/core/support-inbound-secret";
import { BACKEND_ROOT } from "./route-surface";

/**
 * `POST /support/inbound/{email,whatsapp,sms}/:orgId` is `@Public()` and its only
 * tenant selector is a path org id the caller chose, so the shared secret IS the
 * authorization decision. Three properties have to hold on it: the comparison
 * leaks nothing through timing, the stored form is not the credential, and the
 * limit that runs BEFORE the credential is checked is keyed on something the
 * caller cannot name — otherwise an anonymous request can starve a named victim.
 */

const VICTIM_ORG = "org-victim";

const read = (rel: string): string => readFileSync(join(BACKEND_ROOT, rel), "utf8");

describe("BOLA sweep — inbound webhook secret comparison", () => {
  const secret = generateInboundSecret();

  it("accepts the right secret against its stored digest", () => {
    expect(inboundSecretMatches(hashInboundSecret(secret), secret)).toBe(true);
  });

  it("refuses a wrong secret of the same length", () => {
    const wrong = `${secret.slice(0, -1)}${secret.endsWith("a") ? "b" : "a"}`;
    expect(inboundSecretMatches(hashInboundSecret(secret), wrong)).toBe(false);
  });

  /**
   * A naive `timingSafeEqual(Buffer.from(stored), Buffer.from(provided))` throws
   * RangeError on unequal lengths, which is how a length oracle gets reintroduced
   * as an error shape. Returning false is the property.
   */
  it("refuses secrets of every other length without throwing", () => {
    for (const wrong of ["", "a", "a".repeat(10_000), secret.slice(0, 10)]) {
      expect(() => inboundSecretMatches(hashInboundSecret(secret), wrong)).not.toThrow();
      expect(inboundSecretMatches(hashInboundSecret(secret), wrong)).toBe(false);
    }
  });

  it("compares fixed-width digests, so length is not observable at all", () => {
    const widths = new Set(
      ["", "a", "a".repeat(10_000), secret].map((s) => hashInboundSecret(s).length),
    );
    expect(widths.size).toBe(1);
  });

  it("a missing stored secret and a missing presented secret both refuse", () => {
    expect(inboundSecretMatches(null, secret)).toBe(false);
    expect(inboundSecretMatches(undefined, secret)).toBe(false);
    expect(inboundSecretMatches(hashInboundSecret(secret), undefined)).toBe(false);
    expect(inboundSecretMatches(null, null)).toBe(false);
    expect(inboundSecretMatches("", "")).toBe(false);
  });

  it("the comparison is constant-time and the string `!==` compare is gone", () => {
    expect(read("src/modules/support/core/support-inbound-secret.ts")).toContain(
      "timingSafeEqual",
    );
    const service = read("src/modules/support/core/support-channels.service.ts");
    expect(service).not.toContain("channel.inboundSecret !== providedSecret");
    expect(service).toContain("inboundSecretMatches(channel?.inboundSecret, providedSecret)");
  });

  it("the unequal-length branch still does the comparison work before refusing", () => {
    const helper = read("src/modules/support/core/support-inbound-secret.ts");
    const guard = helper.slice(helper.indexOf("if (left.length !== right.length)"));
    expect(guard.slice(0, 120)).toContain("timingSafeEqual(left, left)");
  });
});

describe("BOLA sweep — inbound webhook secret at rest", () => {
  const makeService = () => {
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const stored: { row: Record<string, unknown> | undefined } = { row: undefined };
    const db = {
      query: {
        supportChannels: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn(() => Promise.resolve(stored.row)),
        },
      },
      insert: () => ({
        values: (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return { returning: () => Promise.resolve([{ id: 1, ...payload }]) };
        },
      }),
      update: () => ({
        set: (payload: Record<string, unknown>) => {
          updated.push(payload);
          return {
            where: () => ({ returning: () => Promise.resolve([{ id: 1, ...payload }]) }),
          };
        },
      }),
      transaction: (fn: (tx: unknown) => unknown) => fn(db),
      execute: jest.fn().mockResolvedValue([]),
    };
    const service = new SupportChannelsService(db as never, {} as never);
    return { service, inserted, updated, stored };
  };

  it("stores only a digest and hands the plaintext back exactly once", async () => {
    const { service, inserted } = makeService();

    const created = await service.createChannel(VICTIM_ORG, {
      type: "email",
      name: "Inbox",
      config: {},
      isActive: true,
    });

    const persisted = inserted[0]?.inboundSecret;
    expect(typeof persisted).toBe("string");
    expect(isHashedInboundSecret(persisted as string)).toBe(true);
    expect(persisted).not.toBe(created.inboundSecret);
    expect(inboundSecretMatches(persisted as string, created.inboundSecret)).toBe(true);
  });

  it("the list read does not select the column at all", () => {
    const service = read("src/modules/support/core/support-channels.service.ts");
    const list = service.slice(service.indexOf("listChannels("), service.indexOf("createChannel("));
    expect(list).toContain("columns: { inboundSecret: false }");
  });

  it("rotation mints a new secret, stores its digest and returns the plaintext once", async () => {
    const { service, updated } = makeService();

    const rotated = await service.updateChannel(VICTIM_ORG, 1, { rotateInboundSecret: true });

    const persisted = updated[0]?.inboundSecret;
    expect(isHashedInboundSecret(persisted as string)).toBe(true);
    expect(inboundSecretMatches(persisted as string, rotated.inboundSecret)).toBe(true);
  });

  it("an ordinary update neither rotates nor writes the column", async () => {
    const { service, updated } = makeService();
    await service.updateChannel(VICTIM_ORG, 1, { name: "Renamed" });
    expect(updated[0]).not.toHaveProperty("inboundSecret");
  });

  it("the secret a channel is created with verifies against what was persisted", async () => {
    const { service, inserted, stored } = makeService();
    const created = await service.createChannel(VICTIM_ORG, {
      type: "email",
      name: "Inbox",
      config: {},
      isActive: true,
    });
    stored.row = { id: 1, inboundSecret: inserted[0]?.inboundSecret, config: {} };

    await expect(
      service.verifyInboundSecret(VICTIM_ORG, "email", created.inboundSecret as string),
    ).resolves.toMatchObject({ id: 1 });
  });

});

describe("BOLA sweep — the pre-authentication limit is not keyed on the victim (source)", () => {
  it("the source no longer keys any pre-auth limit on the path org id", () => {
    const controller = read("src/modules/support/core/support-channels.controller.ts");
    for (const channel of ["email", "whatsapp", "sms"]) {
      const preAuth = controller.indexOf(`"support:inbound-${channel}", clientIp(req)`);
      const verify = controller.indexOf(`verifyInboundSecret(orgId, "${channel}"`);
      const perOrg = controller.indexOf(`"support:inbound-${channel}", orgId`);
      expect(preAuth).toBeGreaterThan(-1);
      expect(verify).toBeGreaterThan(preAuth);
      expect(perOrg).toBeGreaterThan(verify);
    }
    expect(controller).not.toContain('"support:chat-widget", orgId)');
  });
});
