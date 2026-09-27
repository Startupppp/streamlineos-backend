import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ExecutionContext, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../../common/ratelimit/use-rate-limit.decorator";
import { KbLinkedDocumentsController } from "./kb-linked-documents.controller";
import { KbLinkedDocumentFileService, LINKED_DOCUMENT_URL_TTL_SECONDS } from "./kb-linked-document-file.service";

const ORG_ID = "org-open-throttle";
const TIER = "kb:linked-document-open";

const SIGNED_URL =
  "https://streamline-hr.r2.cloudflarestorage.com/org-open-throttle/hr-documents/leave-policy.pdf" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260925%2Fauto%2Fs3%2Faws4_request" +
  "&X-Amz-Expires=300&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";


function contextFor(handler: (...args: never[]) => unknown, userId: string | undefined, setHeader: jest.Mock): ExecutionContext {
  const request = { user: userId === undefined ? undefined : { userId }, ip: "203.0.113.7" };
  return {
    getHandler: () => handler,
    getClass: () => KbLinkedDocumentsController,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader }) }),
  } as unknown as ExecutionContext;
}

describe("minting a signed URL for a linked document is throttled", () => {
  const open = KbLinkedDocumentsController.prototype.open;

  it("declares a tier on open and on no other route, so the guard is not a blanket limiter", () => {
    const reflector = new Reflector();

    expect(reflector.get<string>(RATE_LIMIT_TIER, open)).toBe(TIER);
    expect(reflector.get<string>(RATE_LIMIT_TIER, KbLinkedDocumentsController.prototype.list)).toBeUndefined();
    expect(reflector.get<string>(RATE_LIMIT_TIER, KbLinkedDocumentsController.prototype.get)).toBeUndefined();
    expect(reflector.get<string>(RATE_LIMIT_TIER, KbLinkedDocumentsController)).toBeUndefined();
  });

  it("answers 429 with Retry-After once the caller is over the limit, keyed on the caller and not their IP", async () => {
    const setHeader = jest.fn();
    const check = jest.fn().mockResolvedValue({ allowed: false, retryAfterSecs: 42 });
    const guard = new RateLimitGuard(new Reflector(), { check } as never, null as never, null as never);

    const error = await guard.canActivate(contextFor(open, "user-reader", setHeader)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "42");
    expect(check).toHaveBeenCalledWith(TIER, "user-reader");
  });

  it("lets a caller inside the limit through, so the guard is not simply refusing everything", async () => {
    const check = jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const guard = new RateLimitGuard(new Reflector(), { check } as never, null as never, null as never);

    await expect(guard.canActivate(contextFor(open, "user-reader", jest.fn()))).resolves.toBe(true);
  });

  it("is registered in TIERS: check() returns allowed for an unknown tier, so the guard would look protected and do nothing", () => {
    const table = readFileSync(resolve(__dirname, "../../../common/ratelimit/rate-limit.service.ts"), "utf8");
    expect(table).toMatch(new RegExp(`"${TIER}":\\s*\\{`));
  });
});

describe("the signed URL never reaches a log line", () => {
  it("is returned to the caller and written nowhere else — not a log, not the audit row", async () => {
    const written: string[] = [];
    const capture = (...args: unknown[]) => void written.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(" "));
    const spies = [
      jest.spyOn(console, "log").mockImplementation(capture),
      jest.spyOn(console, "info").mockImplementation(capture),
      jest.spyOn(console, "warn").mockImplementation(capture),
      jest.spyOn(console, "error").mockImplementation(capture),
      jest.spyOn(console, "debug").mockImplementation(capture),
      jest.spyOn(Logger.prototype, "log").mockImplementation(capture),
      jest.spyOn(Logger.prototype, "warn").mockImplementation(capture),
      jest.spyOn(Logger.prototype, "error").mockImplementation(capture),
      jest.spyOn(Logger.prototype, "debug").mockImplementation(capture),
      jest.spyOn(Logger.prototype, "verbose").mockImplementation(capture),
    ];

    const auditRows: unknown[] = [];
    const service = new KbLinkedDocumentFileService(
      { resolveFile: jest.fn().mockResolvedValue({ fileKey: `${ORG_ID}/hr-documents/leave-policy.pdf`, fileName: "leave-policy.pdf" }) } as never,
      {
        getFileKeyFromUrl: (value: string) => value,
        isValidFileKey: () => true,
        getFileUrl: jest.fn().mockResolvedValue(SIGNED_URL),
      } as never,
      { logCriticalOutsideTransaction: jest.fn(async (row: unknown) => void auditRows.push(row)) } as never,
    );

    let result: { url: string; expiresIn: number };
    try {
      result = await service.open({ orgId: ORG_ID, userId: "user-reader", canPublish: false }, 5);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(result.url).toBe(SIGNED_URL);
    expect(result.expiresIn).toBe(LINKED_DOCUMENT_URL_TTL_SECONDS);

    const logged = written.join("\n");
    expect(logged).not.toContain(SIGNED_URL);
    expect(logged).not.toContain("X-Amz-Signature");
    expect(logged).not.toMatch(/r2\.cloudflarestorage\.com/i);

    const audited = JSON.stringify(auditRows);
    expect(auditRows).toHaveLength(1);
    expect(audited).toContain("kb.hr_link.document_opened");
    expect(audited).not.toContain(SIGNED_URL);
    expect(audited).not.toMatch(/X-Amz-Signature|X-Amz-Credential|r2\.cloudflarestorage\.com/i);
  });
});
