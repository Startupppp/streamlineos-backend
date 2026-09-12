import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../../../common/security/secret-encryption.util";
import { whatsAppSignatureMatches } from "./whatsapp-webhook";
import { signedDelivery, webhookBody } from "./whatsapp-webhook.fixture";
import { createWhatsappChannelSchema } from "../dto/whatsapp-channel.schemas";
import { WhatsAppChannelsService } from "./whatsapp-channels.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * What a WhatsApp channel row is allowed to hold, and what it must never
 * hand back.
 *
 * The claim being defended is narrow and worth stating plainly: a leak of this
 * whole table lets an attacker forge an inbound message onto a customer's
 * timeline, and does not let them send one, read the organisation's history, or
 * reach anything outside the CRM. That is true only for as long as the row
 * holds no credential that acts on the organisation's behalf — which is a
 * property of the schema, so it is asserted against the schema rather than
 * described in a comment somebody will widen later.
 */

const SCHEMA_FILE = join(__dirname, "../../../db/schema/crm/whatsapp-channels.ts");

/**
 * Anything that would let the holder ACT as the organisation.
 *
 * `app_secret` and `verify_token` are deliberately not here: the first
 * authenticates the provider to us and the second is echoed once during a
 * subscription handshake. Neither can send, read or authorise anything.
 */
const CREDENTIAL_SHAPED = /access.?token|refresh.?token|bearer|api.?key|client.?secret|password/i;

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "whatsapp-channel-secrets-spec-key";
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(currentTx),
  ),
}));

interface Written {
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

let written: Written;
let currentTx: unknown;

/** A transaction that remembers what it was asked to write, and answers. */
function recordingTx(returned: Record<string, unknown>) {
  written = {};
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        written.values = values;
        return { returning: () => Promise.resolve([returned]) };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        written.set = set;
        return { where: () => ({ returning: () => Promise.resolve([returned]) }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([returned]) }),
        }),
      }),
    }),
  };
}

const db = {} as Db;

describe("what a WhatsApp channel is allowed to hold", () => {
  it("declares no column that could act as the organisation", () => {
    const source = readFileSync(SCHEMA_FILE, "utf8");

    const columns = [...source.matchAll(/^\s{4}(\w+):/gm)].map(([, name]) => name);

    expect(columns).toContain("appSecret");
    expect(columns.filter((name) => CREDENTIAL_SHAPED.test(name))).toEqual([]);
  });

  /**
   * The same fence on the way in. A column cannot appear without a schema
   * change, but a `.strict()` object that quietly grows a field is a smaller
   * edit and reaches the same place.
   */
  it("accepts no credential-shaped field on the create request", () => {
    const rejected = createWhatsappChannelSchema.safeParse({
      businessPhoneNumberId: "109876543210987",
      businessNumber: "15550001111",
      appSecret: "a".repeat(32),
      accessToken: "EAAG...",
    });

    expect(rejected.success).toBe(false);
  });

  it("refuses an app secret short enough to be a paste of the wrong field", () => {
    const rejected = createWhatsappChannelSchema.safeParse({
      businessPhoneNumberId: "109876543210987",
      businessNumber: "15550001111",
      appSecret: "short",
    });

    expect(rejected.success).toBe(false);
  });
});

describe("secrets at rest on a WhatsApp channel", () => {
  const appSecret = "b".repeat(32);
  const input = {
    businessPhoneNumberId: "109876543210987",
    businessNumber: "15550001111",
    appSecret,
  };

  beforeEach(() => {
    currentTx = recordingTx({
      crmWhatsappChannelId: "wa-1",
      businessPhoneNumberId: input.businessPhoneNumberId,
      businessNumber: input.businessNumber,
      enabled: true,
      createdAt: new Date("2026-09-09T00:00:00.000Z"),
    });
  });

  it("writes both secrets as ciphertext", async () => {
    await new WhatsAppChannelsService(db).create("org-1", input);

    const values = written.values ?? {};
    expect(isEncryptedSecret(String(values["appSecret"]))).toBe(true);
    expect(isEncryptedSecret(String(values["verifyToken"]))).toBe(true);
    expect(String(values["appSecret"])).not.toContain(appSecret);
  });

  /**
   * The round trip that matters. Encryption is only correct if what comes back
   * out still verifies a real delivery — a secret that stores cleanly and
   * decrypts to something else rejects every genuine message and looks exactly
   * like a provider that went quiet.
   */
  it("round-trips to a secret that still verifies a real delivery", async () => {
    await new WhatsAppChannelsService(db).create("org-1", input);

    const stored = String((written.values ?? {})["appSecret"]);
    const { rawBody, signature } = signedDelivery(webhookBody(), appSecret);

    expect(whatsAppSignatureMatches(rawBody, signature, decryptSecret(stored))).toBe(true);
  });

  it("returns the verify token once and the app secret never", async () => {
    const created = await new WhatsAppChannelsService(db).create("org-1", input);

    expect(created.verifyToken).toEqual(expect.any(String));
    expect(created.appSecretHint).toBe(`****${appSecret.slice(-4)}`);
    expect(JSON.stringify(created)).not.toContain(appSecret);
    expect(Object.keys(created)).not.toContain("appSecret");
  });

  /**
   * The token that is handed over must be the plaintext of what was stored,
   * not the ciphertext and not an unrelated string — otherwise the handshake
   * it exists for fails the first time it is used.
   */
  it("hands back the plaintext of the token it stored", async () => {
    const created = await new WhatsAppChannelsService(db).create("org-1", input);

    expect(decryptSecret(String((written.values ?? {})["verifyToken"]))).toBe(created.verifyToken);
  });

  it("names no secret column in the list projection", async () => {
    currentTx = recordingTx({
      crmWhatsappChannelId: "wa-1",
      businessPhoneNumberId: input.businessPhoneNumberId,
      businessNumber: input.businessNumber,
      enabled: true,
      lastDeliveryAt: null,
      lastAcceptedAt: null,
      lastNote: null,
      createdAt: new Date("2026-09-09T00:00:00.000Z"),
    });

    const [row] = await new WhatsAppChannelsService(db).list("org-1");

    expect(Object.keys(row ?? {})).not.toContain("appSecret");
    expect(Object.keys(row ?? {})).not.toContain("verifyToken");
  });
});

describe("rotation", () => {
  beforeEach(() => {
    currentTx = recordingTx({ crmWhatsappChannelId: "wa-1" });
  });

  /**
   * The two secrets have different owners, so they rotate on different
   * occasions. Minting an app secret here would be minting one Meta has never
   * heard of, which stops verifying every delivery from that moment on.
   */
  it("replaces the verify token and leaves the provider's secret alone", async () => {
    const result = await new WhatsAppChannelsService(db).rotate("org-1", "wa-1", {});

    const set = written.set ?? {};
    expect(isEncryptedSecret(String(set["verifyToken"]))).toBe(true);
    expect(set).not.toHaveProperty("appSecret");
    expect(decryptSecret(String(set["verifyToken"]))).toBe(result.verifyToken);
  });

  it("replaces the app secret when the caller supplies the new one", async () => {
    const replacement = "c".repeat(32);

    const result = await new WhatsAppChannelsService(db).rotate("org-1", "wa-1", {
      appSecret: replacement,
    });

    const set = written.set ?? {};
    expect(decryptSecret(String(set["appSecret"]))).toBe(replacement);
    expect(JSON.stringify(result)).not.toContain(replacement);
  });

  it("gives a new token every time, so a replayed response is worthless", async () => {
    const service = new WhatsAppChannelsService(db);

    const first = await service.rotate("org-1", "wa-1", {});
    const second = await service.rotate("org-1", "wa-1", {});

    expect(first.verifyToken).not.toBe(second.verifyToken);
  });
});
