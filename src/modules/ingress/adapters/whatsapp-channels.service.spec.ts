import { WhatsAppChannelsService } from "./whatsapp-channels.service";
import { encryptSecret } from "../../../common/security/secret-encryption.util";
import type { Db } from "../../../db/drizzle.module";

/**
 * Resolving a delivery's tenant, at the two points where being wrong is silent.
 *
 * The RLS argument this service makes — that
 * `app.resolve_whatsapp_channel_org_id` returns an org id and nothing else, and
 * that the secret is then read under the policy — can only be proved against a
 * database, and is, in the seeded suite. What is provable here is the pair of
 * failures that produce no error at all:
 *
 *   1. A delivery for a line nobody has registered must not reach the tenant
 *      path. If it did, the read would run for an empty organisation id and the
 *      refusal would come from the wrong layer.
 *   2. A stored secret must be decrypted before it verifies anything. Verifying
 *      against ciphertext rejects every genuine delivery and looks exactly like
 *      a provider that has stopped sending.
 */

const ROW = {
  crmWhatsappChannelId: "wa-1",
  organizationId: "org-1",
  businessPhoneNumberId: "109876543210987",
  businessNumber: "15550001111",
  appSecret: "",
  verifyToken: null as string | null,
};

/**
 * A database that answers the resolver function and then the row read.
 *
 * `runInNewTenantTransaction` reaches `withTenant`, which this double cannot
 * satisfy — so the tenant leg is substituted at the module boundary rather than
 * faked underneath it, and what is left under test is the ordering: what is
 * asked of the database first, and what is done with what comes back.
 */
function dbReturning(orgId: string | null) {
  const execute = jest.fn(() => Promise.resolve(orgId ? [{ org_id: orgId }] : []));
  return { execute } as unknown as Db;
}

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(txReturningRow()),
  ),
}));

let currentRow: typeof ROW | null = ROW;

function txReturningRow() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(currentRow ? [currentRow] : []),
        }),
      }),
    }),
  };
}

describe("WhatsAppChannelsService", () => {
  const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "whatsapp-channels-spec-key";
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  beforeEach(() => {
    currentRow = { ...ROW, appSecret: encryptSecret("the-app-secret") };
  });

  it("hands back the decrypted secret, because ciphertext verifies nothing", async () => {
    const service = new WhatsAppChannelsService(dbReturning("org-1"));

    const channel = await service.resolveByPhoneNumberId("109876543210987");

    expect(channel?.binding.appSecret).toBe("the-app-secret");
    expect(channel?.binding.organizationId).toBe("org-1");
  });

  /**
   * A seed or a fixture that wrote plaintext still has to work, or the failure
   * shows up as "the provider stopped sending" rather than as a bad column.
   */
  it("reads a plaintext secret as-is", async () => {
    currentRow = { ...ROW, appSecret: "written-before-encryption" };
    const service = new WhatsAppChannelsService(dbReturning("org-1"));

    const channel = await service.resolveByPhoneNumberId("109876543210987");

    expect(channel?.binding.appSecret).toBe("written-before-encryption");
  });

  it("decrypts the verify token by the same rule", async () => {
    currentRow = {
      ...ROW,
      appSecret: encryptSecret("the-app-secret"),
      verifyToken: encryptSecret("the-verify-token"),
    };
    const service = new WhatsAppChannelsService(dbReturning("org-1"));

    const channel = await service.resolveByChannelId("wa-1");

    expect(channel?.verifyToken).toBe("the-verify-token");
  });

  it("is null for a line no organisation has registered", async () => {
    const service = new WhatsAppChannelsService(dbReturning(null));

    expect(await service.resolveByPhoneNumberId("000000000000000")).toBeNull();
  });

  /**
   * An empty line never becomes a query. The resolver function would return
   * null for it anyway, but a lookup that reaches the database for a value the
   * caller could not read out of the body is one more way for a body to steer
   * a query.
   */
  it("does not query at all for a blank identifier", async () => {
    const db = dbReturning("org-1");
    const service = new WhatsAppChannelsService(db);

    expect(await service.resolveByPhoneNumberId("   ")).toBeNull();
    expect(await service.resolveByChannelId("")).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("is null when the resolver names an organisation the row read cannot find", async () => {
    currentRow = null;
    const service = new WhatsAppChannelsService(dbReturning("org-1"));

    expect(await service.resolveByChannelId("wa-1")).toBeNull();
  });
});
