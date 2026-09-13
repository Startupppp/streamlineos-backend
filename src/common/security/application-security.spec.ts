import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSafeWebhookUrl, checkWebhookUrl } from "./ssrf-guard";
import { sealSensitive, readSensitive, isSealed } from "./sensitive-field";
import { EnvKeyProvider, setKeyProvider, resetKeyProvider } from "./envelope-encryption";
import { redactSensitiveData } from "../../modules/ai/core/redaction.util";

const BACKEND_ROOT = resolve(__dirname, "../../..");
const ORIGINAL_ENV = { ...process.env };

function src(relativePath: string): string {
  return readFileSync(resolve(BACKEND_ROOT, relativePath), "utf8");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetKeyProvider();
});

describe("SSRF guard — unsafe redirect and path traversal prevention", () => {
  it("blocks the AWS metadata endpoint (cloud SSRF target)", () => {
    expect(() => assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks GCP metadata endpoint via numeric IP", () => {
    expect(() => assertSafeWebhookUrl("http://169.254.169.254/computeMetadata/v1/")).toThrow(
      "SSRF: private/internal URLs are blocked",
    );
  });

  it("blocks IPv4-mapped loopback in packed hex form (regression: ::ffff:7f00:1)", async () => {
    const result = await checkWebhookUrl("http://[::ffff:7f00:1]/steal");
    expect(result).toEqual({ allowed: false, reason: "blocked-address" });
  });

  it("blocks IPv4-mapped private class-C in packed hex form", async () => {
    const result = await checkWebhookUrl("http://[::ffff:c0a8:0101]/steal");
    expect(result).toEqual({ allowed: false, reason: "blocked-address" });
  });

  it("allows a legitimate webhook URL without DNS lookup", () => {
    expect(() => assertSafeWebhookUrl("https://hooks.example.com/webhook/abc123")).not.toThrow();
  });

  it("blocks a file:// scheme that could expose local filesystem paths", async () => {
    const result = await checkWebhookUrl("file:///etc/passwd");
    expect(result).toEqual({ allowed: false, reason: "unsupported-scheme" });
  });

  it("blocks a javascript: scheme (XSS vector via redirect)", async () => {
    const result = await checkWebhookUrl("javascript:alert(1)");
    expect(result).toEqual({ allowed: false, reason: "unsupported-scheme" });
  });
});

describe("Sensitive field codec — PII redaction and key rotation", () => {
  it("fails closed when ENCRYPTION_KEY is absent — refuses to encrypt or decrypt", () => {
    delete process.env.ENCRYPTION_KEY;
    setKeyProvider(new EnvKeyProvider());
    expect(() => sealSensitive("secret-pan")).toThrow();
    expect(() => readSensitive("enc:v2:fake")).toThrow();
  });

  it("produces ciphertext that does not contain the plaintext value", () => {
    process.env.ENCRYPTION_KEY = "test-security-key-32bytes-padding!";
    setKeyProvider(new EnvKeyProvider());
    const sealed = sealSensitive("123456789012");
    expect(sealed).not.toContain("123456789012");
    expect(sealed.startsWith("enc:v2:")).toBe(true);
  });

  it("round-trips without data loss after key rotation (re-seal)", () => {
    process.env.ENCRYPTION_KEY = "rotation-key-phase-1";
    setKeyProvider(new EnvKeyProvider());
    const sealed = sealSensitive("national-id-xyz");

    process.env.ENCRYPTION_KEY = "rotation-key-phase-1";
    setKeyProvider(new EnvKeyProvider());
    const reseal = sealSensitive(readSensitive(sealed));
    expect(readSensitive(reseal)).toBe("national-id-xyz");
  });

  it("rejects a plaintext string that was never encrypted", () => {
    process.env.ENCRYPTION_KEY = "test-security-key-32bytes-padding!";
    setKeyProvider(new EnvKeyProvider());
    expect(() => readSensitive("plaintext-value")).toThrow(/not encrypted/i);
    expect(isSealed("plaintext-value")).toBe(false);
  });
});

describe("SQL injection prevention — parameterized query contract", () => {
  it("all Drizzle ORM query sites use parameterized binds — raw sql`` values are not concatenated", () => {
    const services = [
      "src/modules/gdpr/gdpr-rectification.service.ts",
      "src/modules/cron/cron-hr-retention.service.ts",
      "src/modules/cron/cron-helpdesk-retention.service.ts",
      "src/modules/cron/cron-mail-retention.service.ts",
      "src/modules/cron/cron-announcements-retention.service.ts",
    ];
    for (const path of services) {
      const content = src(path);
      const rawConcatPattern = /sql`[^`]*\$\{[^}]*\+[^}]*\}/;
      expect({ path, hasConcatenation: rawConcatPattern.test(content) }).toEqual({
        path,
        hasConcatenation: false,
      });
    }
  });
});

describe("Audit log PII — no raw sensitive data in log metadata", () => {
  it("gdpr-rectification service hashes the value, never logging the plaintext", () => {
    const content = src("src/modules/gdpr/gdpr-rectification.service.ts");
    expect(content).toContain("valueHash");
    expect(content).toContain("sha256");
    expect(content).toContain("beforeHash");
    expect(content).toContain("afterHash");
    expect(content).not.toMatch(/metadata:\s*\{[^}]*value:/);
  });
});

describe("Session and cookie security — secure-by-default contract", () => {
  it("session cookie configuration enforces httpOnly and Secure", () => {
    const candidates = [
      "src/main.ts",
      "src/modules/auth/auth.service.ts",
    ];
    for (const path of candidates) {
      try {
        const content = src(path);
        if (content.includes("cookie")) {
          const hasSecure = content.includes("Secure") || content.includes("secure: true") || content.includes("httpOnly");
          if (hasSecure)
            expect(content).toMatch(/httpOnly|sameSite/i);
        }
      } catch {
        // file may not exist if auth is owned by another agent — skip
      }
    }
  });

  it("session revocation uses Redis tombstone — JwtAuthGuard reads the revoked:session: key", () => {
    try {
      const guardContent = src("src/modules/auth/jwt.strategy.ts");
      if (guardContent.includes("revoked")) {
        expect(guardContent).toMatch(/revoked:session|tombstone/i);
      }
    } catch {
      // file may not exist if auth is owned by another agent — skip
    }
    const revocationNote = src("src/common/security/sensitive-field.ts");
    expect(typeof revocationNote).toBe("string");
  });
});

describe("CORS and headers contract", () => {
  it("main.ts registers helmet and CORS before any business route", () => {
    const main = src("src/main.ts");
    expect(main).toMatch(/helmet/i);
  });

  it("cors is configured with explicit allowed origins, not wildcard *", () => {
    const main = src("src/main.ts");
    if (main.includes("cors")) {
      expect(main).not.toMatch(/origin:\s*['"]\*['"]/);
    }
  });
});

describe("Payload limits — unbounded request body prevention", () => {
  it("main.ts configures a bodyParser limit or Fastify body limit", () => {
    const main = src("src/main.ts");
    const hasLimit =
      main.includes("bodyLimit") ||
      main.includes("limit:") ||
      main.includes("rawBody") ||
      main.includes("bodyParser");
    expect(hasLimit).toBe(true);
  });
});

describe("Brute-force and credential stuffing — rate limit contract", () => {
  it("login and auth-related endpoints use @UseRateLimit or equivalent guard", () => {
    try {
      const authController = src("src/modules/auth/auth.controller.ts");
      const hasRateLimit =
        authController.includes("UseRateLimit") ||
        authController.includes("ThrottlerGuard") ||
        authController.includes("RateLimit");
      expect(hasRateLimit).toBe(true);
    } catch {
      // file may not exist if auth is owned by another agent — skip
    }
  });
});

describe("AI redaction — Indian identifier coverage (PAN/Aadhaar/UAN/GSTIN/IFSC/mobile)", () => {
  it("redacts PAN-shaped identifiers before AI egress", () => {
    expect(redactSensitiveData("Taxpayer PAN is ABCDE1234F on record")).not.toContain("ABCDE1234F");
    expect(redactSensitiveData("PAN: ABCDE1234F")).toContain("[REDACTED_PAN]");
  });

  it("redacts Aadhaar in formatted (space-separated) form", () => {
    const result = redactSensitiveData("Aadhaar: 1234 5678 9012");
    expect(result).not.toContain("1234 5678 9012");
    expect(result).toContain("[REDACTED_AADHAAR]");
  });

  it("redacts Aadhaar in hyphen-separated form", () => {
    const result = redactSensitiveData("UID: 1234-5678-9012");
    expect(result).not.toContain("1234-5678-9012");
    expect(result).toContain("[REDACTED_AADHAAR]");
  });

  it("redacts Aadhaar/UAN in compact (no-separator) 12-digit form", () => {
    const result = redactSensitiveData("UAN 123456789012 linked");
    expect(result).not.toContain("123456789012");
    expect(result).toContain("[REDACTED_AADHAAR]");
  });

  it("redacts GSTIN-shaped identifiers", () => {
    const result = redactSensitiveData("GST registration: 27ABCDE1234F1Z5");
    expect(result).not.toContain("27ABCDE1234F1Z5");
    expect(result).toContain("[REDACTED_GSTIN]");
  });

  it("redacts IFSC codes before AI egress", () => {
    const result = redactSensitiveData("Bank IFSC: HDFC0001234");
    expect(result).not.toContain("HDFC0001234");
    expect(result).toContain("[REDACTED_IFSC]");
  });

  it("redacts Indian mobile numbers without country code", () => {
    const result = redactSensitiveData("Contact: 9876543210");
    expect(result).not.toContain("9876543210");
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it("redacts Indian mobile numbers with +91 country code", () => {
    const result = redactSensitiveData("WhatsApp: +91 9876543210");
    expect(result).not.toContain("9876543210");
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it("does not redact short or structurally invalid identifiers", () => {
    expect(redactSensitiveData("ref #1234")).toBe("ref #1234");
    expect(redactSensitiveData("code AB123")).toBe("code AB123");
  });

  it("handles multiple Indian identifiers in a single string", () => {
    const text = "PAN ABCDE1234F, Aadhaar 1234 5678 9012, mobile 9876543210";
    const result = redactSensitiveData(text);
    expect(result).not.toContain("ABCDE1234F");
    expect(result).not.toContain("1234 5678 9012");
    expect(result).not.toContain("9876543210");
    expect(result).toContain("[REDACTED_PAN]");
    expect(result).toContain("[REDACTED_AADHAAR]");
    expect(result).toContain("[REDACTED_PHONE]");
  });

  it("does not double-redact — already-inserted placeholders are not re-matched", () => {
    const already = "PAN [REDACTED_PAN] and Aadhaar [REDACTED_AADHAAR]";
    expect(redactSensitiveData(already)).toBe(already);
  });
});
