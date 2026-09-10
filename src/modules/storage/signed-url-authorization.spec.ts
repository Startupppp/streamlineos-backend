import { NotFoundException } from "@nestjs/common";
import { StorageService } from "./storage.service";
import type { AppConfig } from "../../config/env.validation";
import { isOwnOrgStorageKey, isWellFormedStorageKey } from "./storage-key";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function storageConfig(): AppConfig {
  return {
    NODE_ENV: "test",
    PORT: 1500,
    DATABASE_URL: "postgres://test",
    BACKEND_JWT_SECRET: "x".repeat(44),
    PORTAL_JWT_SECRET: "x".repeat(44),
    CORS_ORIGINS: "http://localhost",
    APP_URL: "http://localhost:3000",
    ENCRYPTION_KEY: "x".repeat(32),
    corsOrigins: ["http://localhost"],
    R2_REGION: "auto",
    R2_BUCKET_NAME: "files",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_ENDPOINT: "https://r2.example",
    NEXT_PUBLIC_R2_PUBLIC_URL: "https://pub-cdn.example.com",
  } as AppConfig;
}

function serviceWith(blocked: ReadonlySet<string> = new Set()): StorageService {
  return new StorageService({} as never, storageConfig(), {
    isKeyBlocked: async (_orgId: string, key: string) => blocked.has(key),
  });
}

/**
 * PRD-C103, "authorization recheck before short-lived download URLs" and
 * "malware quarantine".
 *
 * Before this gate existed the recheck ran on exactly one of fourteen call
 * sites. Every other caller authorised the ROW and then handed `getFileUrl`
 * whatever key the row carried, so a key a client had once chosen — a chat
 * attachment naming its own org's `documents/` folder, a vault row holding a
 * foreign prefix — became a signed URL for an object its reader was never
 * entitled to. The refusal therefore belongs in the minting primitive, where
 * no caller can omit it, and `preauthorized` is the single explicit opt-out for
 * a caller that has already run the record-scoped check.
 */
describe("StorageService.getFileUrl — authorization recheck at the minting seam", () => {
  it("signs a plain, own-organisation key", async () => {
    const url = await serviceWith().getFileUrl(ORG_A, `${ORG_A}/uploads/1-a.pdf`, 60);
    expect(url).toContain("X-Amz-Signature");
  });

  it("refuses a key naming another organisation", async () => {
    await expect(
      serviceWith().getFileUrl(ORG_A, `${ORG_B}/uploads/1-a.pdf`, 60),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a malformed key rather than handing it to the object store", async () => {
    await expect(
      serviceWith().getFileUrl(ORG_A, `${ORG_A}/../${ORG_B}/documents/1-a.pdf`, 60),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * The intra-tenant escalation. `<own-org>/documents/…` passes every write
   * guard in chat, and the chat read path runs no sensitive-folder check of its
   * own, so this is the only place the payslip can be refused.
   */
  it("refuses a sensitive-folder key when the caller has not preauthorized it", async () => {
    for (const folder of ["documents", "payslips", "hr", "esign", "candidate-vault"]) {
      await expect(
        serviceWith().getFileUrl(ORG_A, `${ORG_A}/${folder}/1-payslip.pdf`, 60),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it("signs a sensitive-folder key for a caller that states it preauthorized", async () => {
    const url = await serviceWith().getFileUrl(
      ORG_A,
      `${ORG_A}/documents/1-payslip.pdf`,
      60,
      undefined,
      { preauthorized: true },
    );
    expect(url).toContain("X-Amz-Signature");
  });

  /**
   * Preauthorization is a statement about the caller's record check, not about
   * the object. An infected object has no authorised reader, so the quarantine
   * is consulted on both paths.
   */
  it("refuses a quarantined key even when the caller preauthorized it", async () => {
    const key = `${ORG_A}/documents/1-payslip.pdf`;
    await expect(
      serviceWith(new Set([key])).getFileUrl(ORG_A, key, 60, undefined, {
        preauthorized: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a quarantined key on the ordinary path too", async () => {
    const key = `${ORG_A}/uploads/1-a.pdf`;
    await expect(
      serviceWith(new Set([key])).getFileUrl(ORG_A, key, 60),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * The region-prefixed key shape. `StoragePlacement.objectKey` puts the region
   * prefix AHEAD of the organisation, so a prefix-based check would refuse a
   * tenant its own object; the parser has to be the thing that answers.
   */
  it("distinguishes own from foreign under a region key prefix", async () => {
    const svc = serviceWith();
    await expect(
      svc.getFileUrl(ORG_A, `eu/${ORG_B}/uploads/1-a.pdf`, 60),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getFileUrl(ORG_A, `eu/${ORG_A}/uploads/1-a.pdf`, 60)).resolves.toContain(
      "X-Amz-Signature",
    );
  });
});

/**
 * The ingestion counterpart. Chat, the candidate vault and the KB attachment
 * route all store a key the client chose without any bytes passing through, so
 * this predicate is the only thing between a client string and a stored pointer.
 */
describe("isOwnOrgStorageKey — the predicate every key-ingestion route owes its tenant", () => {
  it("accepts the tenant's own key in both live shapes", () => {
    expect(isOwnOrgStorageKey(`${ORG_A}/uploads/1-a.pdf`, ORG_A)).toBe(true);
    expect(isOwnOrgStorageKey(`eu/${ORG_A}/uploads/1-a.pdf`, ORG_A)).toBe(true);
  });

  it("rejects a foreign organisation's key", () => {
    expect(isOwnOrgStorageKey(`${ORG_B}/uploads/1-a.pdf`, ORG_A)).toBe(false);
    expect(isOwnOrgStorageKey(`eu/${ORG_B}/uploads/1-a.pdf`, ORG_A)).toBe(false);
  });

  it("rejects a legacy key that names no organisation at all", () => {
    expect(isOwnOrgStorageKey("documents/1-a.pdf", ORG_A)).toBe(false);
  });

  it("rejects traversal, absolute, scheme-bearing and query-bearing keys", () => {
    for (const bad of [
      `${ORG_A}/../${ORG_B}/documents/a.pdf`,
      `/${ORG_A}/uploads/a.pdf`,
      "https://attacker.example/a.pdf",
      `${ORG_A}/uploads/a.pdf?x=1`,
      `${ORG_A}/uploads/a.pdf#f`,
      `${ORG_A}\\uploads\\a.pdf`,
      "",
    ]) {
      expect(isWellFormedStorageKey(bad)).toBe(false);
      expect(isOwnOrgStorageKey(bad, ORG_A)).toBe(false);
    }
  });
});

/**
 * A signed URL is only a control if it stops working. `getFileUrl` is the one place chat
 * attachments become a URL, and the historical defect was minting a PERMANENT public
 * link — which passes every access test on the day it is written and leaks forever after.
 */
describe("StorageService.getFileUrl — the URL expires", () => {
  const CHAT_KEY = `${ORG_A}/uploads/chat-attachment.pdf`;

  function paramsOf(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it("carries the exact TTL the caller asked for, not a default", async () => {
    const short = await serviceWith().getFileUrl(ORG_A, CHAT_KEY, 60);
    const chat = await serviceWith().getFileUrl(ORG_A, CHAT_KEY, 3600);

    expect(paramsOf(short).get("X-Amz-Expires")).toBe("60");
    expect(paramsOf(chat).get("X-Amz-Expires")).toBe("3600");
  });

  it("is bounded and signed at a point in time — never a permanent link", async () => {
    const params = paramsOf(await serviceWith().getFileUrl(ORG_A, CHAT_KEY, 3600));

    const expires = Number(params.get("X-Amz-Expires"));
    expect(Number.isFinite(expires)).toBe(true);
    expect(expires).toBeGreaterThan(0);
    expect(expires).toBeLessThanOrEqual(7 * 24 * 60 * 60);

    expect(params.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(params.get("X-Amz-Signature")).toBeTruthy();
  });

  it("is not the public CDN base — a chat attachment never becomes a public object URL", async () => {
    const url = await serviceWith().getFileUrl(ORG_A, CHAT_KEY, 3600);

    expect(url.startsWith("https://pub-cdn.example.com")).toBe(false);
    expect(url).toContain("X-Amz-Signature");
  });
});
