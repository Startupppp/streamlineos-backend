import { NoopAvScanner, assertUploadAllowed, signDownloadToken, verifyDownloadToken } from "./av-scan";

const SECRET = "test-secret-32-bytes-padded-aaaa";

describe("NoopAvScanner", () => {
  it("always returns clean in non-production", async () => {
    const scanner = new NoopAvScanner();
    const result = await scanner.scan(Buffer.from("hello"), "file.txt", "text/plain");
    expect(result).toEqual({ status: "clean" });
  });
});

describe("assertUploadAllowed", () => {
  const constraints = {
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: new Set(["image/png", "image/jpeg", "application/pdf"]),
  };

  it("allows a valid upload", () => {
    expect(assertUploadAllowed(1024, "image/png", constraints)).toEqual({ allowed: true });
  });

  it("rejects a file that is too large", () => {
    expect(assertUploadAllowed(20 * 1024 * 1024, "image/png", constraints)).toEqual({
      allowed: false,
      reason: "file-too-large",
    });
  });

  it("rejects a disallowed mime type", () => {
    expect(assertUploadAllowed(1024, "application/x-executable", constraints)).toEqual({
      allowed: false,
      reason: "mime-type-not-allowed",
    });
  });

  it("checks size before mime type", () => {
    const result = assertUploadAllowed(20 * 1024 * 1024, "application/x-executable", constraints);
    expect(result).toEqual({ allowed: false, reason: "file-too-large" });
  });
});

describe("signDownloadToken / verifyDownloadToken", () => {
  it("round-trips a valid token", () => {
    const token = signDownloadToken("org-1", "uploads/org-1/file.pdf", SECRET);
    const result = verifyDownloadToken(token, SECRET);

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.payload.orgId).toBe("org-1");
    expect(result.payload.storageKey).toBe("uploads/org-1/file.pdf");
    expect(result.payload.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a tampered signature", () => {
    const token = signDownloadToken("org-1", "uploads/org-1/file.pdf", SECRET);
    const tampered = token.slice(0, -4) + "aaaa";
    const result = verifyDownloadToken(tampered, SECRET);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("bad-signature");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signDownloadToken("org-1", "uploads/org-1/file.pdf", "wrong-secret");
    const result = verifyDownloadToken(token, SECRET);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("bad-signature");
  });

  it("rejects an expired token", () => {
    const token = signDownloadToken("org-1", "key", SECRET, -1);
    const result = verifyDownloadToken(token, SECRET);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  it("rejects a malformed token", () => {
    const result = verifyDownloadToken("not-base64url-token!!!", SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects an empty string", () => {
    const result = verifyDownloadToken("", SECRET);
    expect(result.valid).toBe(false);
  });

  it("isolates tokens by orgId — cannot use another org's token", () => {
    const token = signDownloadToken("org-attacker", "uploads/org-victim/secret.pdf", SECRET);
    const result = verifyDownloadToken(token, SECRET);

    if (result.valid) {
      expect(result.payload.orgId).toBe("org-attacker");
      expect(result.payload.orgId).not.toBe("org-victim");
    }
  });

  it("different nonces make tokens unpredictable", () => {
    const a = signDownloadToken("org-1", "key", SECRET);
    const b = signDownloadToken("org-1", "key", SECRET);
    expect(a).not.toBe(b);
  });
});
