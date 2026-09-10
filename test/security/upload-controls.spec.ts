/**
 * upload-controls.spec.ts
 *
 * Static verification of upload type, size and magic-byte controls in
 * storage.controller.ts and file-signatures.ts.
 *
 * No live database or network needed.
 *
 * Documents findings:
 *   F1 — 10 MB app-level vs 50 MB multer gap: multer accepts up to 50 MB but the
 *        controller rejects files over 10 MB.  An attacker who uploads a 40 MB file
 *        causes multer to stream the full body into memory before the 10 MB check
 *        fires — the parse overhead is real even though the file is rejected.
 *   F2 — validateMagicBytes returns true for unknown mime types.  Given that
 *        ALLOWED_UPLOAD_TYPES is an explicit allowlist, this is SAFE in the current
 *        upload path (an unlisted type is rejected before validateMagicBytes is
 *        called).  The gap would become a real bypass if ALLOWED_UPLOAD_TYPES were
 *        widened without adding the mime type to FILE_SIGNATURES.
 *   F3 — No quarantine or malware scan step.  Files are stored immediately after
 *        magic-byte and type checks.
 *   F4 — FIXED 2026-09-10. Two copies of multer existed and the vulnerable one was
 *        the one serving uploads. `multer` is a direct dependency, but
 *        `FileInterceptor` comes from `@nestjs/platform-express`, which declares
 *        `"multer": "2.2.0"` EXACTLY — so bumping the direct dependency moved a
 *        copy nothing imports and left the request path on 2.2.0, which has a DoS
 *        via crafted multipart field names (GHSA, patched >=2.3.0). That is
 *        reachable unauthenticated: feedbucket-public.controller.ts is `@Public()`
 *        with two upload routes, and its multer `limits` set only `fileSize`,
 *        which does not bound field names. Closed with a pnpm override, and
 *        pinned below — an override is invisible in package.json's dependency
 *        list, so without a test it is one `pnpm update` from silently reverting.
 *
 * Suite: run with  node ./node_modules/jest/bin/jest.js test/security/upload-controls.spec.ts
 *   Requires WIRING: "roots" in jest config must include "<rootDir>/test".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

describe("upload type allowlist", () => {
  const controllerSrc = src("src/modules/storage/storage.controller.ts");

  it("ALLOWED_UPLOAD_TYPES is defined", () => {
    expect(controllerSrc).toMatch(/ALLOWED_UPLOAD_TYPES/);
  });

  const expectedTypes = [
    "image/jpeg",
    "image/png",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];

  it.each(expectedTypes)("ALLOWED_UPLOAD_TYPES includes %s", (mime) => {
    expect(controllerSrc).toContain(mime);
  });

  it("uploads are rejected if mime type not in ALLOWED_UPLOAD_TYPES", () => {
    expect(controllerSrc).toMatch(
      /ALLOWED_UPLOAD_TYPES\.includes\s*\(file\.mimetype\)/,
    );
    expect(controllerSrc).toMatch(/File type not allowed/);
  });
});

describe("upload size limit", () => {
  const controllerSrc = src("src/modules/storage/storage.controller.ts");

  it("MAX_UPLOAD_SIZE is 10 MB at the application level", () => {
    expect(controllerSrc).toMatch(/MAX_UPLOAD_SIZE\s*=\s*10\s*\*\s*1024\s*\*\s*1024/);
  });

  it("F1 FINDING — multer limit is 50 MB while app limit is 10 MB", () => {
    expect(controllerSrc).toMatch(/fileSize:\s*50\s*\*\s*1024\s*\*\s*1024/);
    expect(controllerSrc).toMatch(/MAX_UPLOAD_SIZE\s*=\s*10\s*\*\s*1024\s*\*\s*1024/);
  });

  it("app-level size check fires before storage upload", () => {
    const maxCheckIdx = controllerSrc.indexOf("file.size > MAX_UPLOAD_SIZE");
    const uploadIdx = controllerSrc.indexOf("uploadCompressed");
    expect(maxCheckIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(maxCheckIdx).toBeLessThan(uploadIdx);
  });
});

describe("magic-byte validation", () => {
  const controllerSrc = src("src/modules/storage/storage.controller.ts");
  const sigSrc = src("src/modules/storage/file-signatures.ts");

  it("validateMagicBytes is called before upload", () => {
    const magicCheckIdx = controllerSrc.indexOf("validateMagicBytes");
    const uploadIdx = controllerSrc.indexOf("uploadCompressed");
    expect(magicCheckIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(magicCheckIdx).toBeLessThan(uploadIdx);
  });

  it("FILE_SIGNATURES covers JPEG, PNG, PDF", () => {
    expect(sigSrc).toMatch(/"image\/jpeg"/);
    expect(sigSrc).toMatch(/"image\/png"/);
    expect(sigSrc).toMatch(/"application\/pdf"/);
  });

  it("F2 FINDING — validateMagicBytes returns true for unknown mime types", () => {
    const unknownMimePath = sigSrc.indexOf("if (!signatures) return true");
    expect(unknownMimePath).toBeGreaterThan(-1);
  });

  it("F2 is SAFE given the type allowlist — unknown types are blocked before validateMagicBytes call", () => {
    const typeCheckIdx = controllerSrc.indexOf("ALLOWED_UPLOAD_TYPES.includes");
    const magicCallIdx = controllerSrc.indexOf("validateMagicBytes(");
    expect(typeCheckIdx).toBeGreaterThan(-1);
    expect(magicCallIdx).toBeGreaterThan(-1);
    expect(typeCheckIdx).toBeLessThan(magicCallIdx);
  });

  it("rejection message is clear when magic bytes mismatch", () => {
    expect(controllerSrc).toMatch(
      /File content does not match declared type/,
    );
  });
});

describe("sensitive download controls", () => {
  const controllerSrc = src("src/modules/storage/storage.controller.ts");

  it("SENSITIVE_KEY_PREFIXES prevents serving sensitive paths without auth", () => {
    expect(controllerSrc).toMatch(/SENSITIVE_KEY_PREFIXES/);
    expect(controllerSrc).toMatch(/"payroll\//);
    expect(controllerSrc).toMatch(/"hr-documents\//);
    expect(controllerSrc).toMatch(/"candidate-vault\//);
  });

  it("isSensitiveKey check is applied to download path", () => {
    expect(controllerSrc).toMatch(/isSensitiveKey\s*\(/);
    expect(controllerSrc).toMatch(/Access denied/);
  });

  it("F3 FINDING — no quarantine or malware scan step exists", () => {
    expect(controllerSrc).not.toMatch(/quarantine|malware|virus|scan/i);
  });
});

/*
 * F4's pin. This block is deliberately NOT static like the rest of the file:
 * the claim is about which code actually runs, and the source text cannot say
 * that — package.json shows `multer` at the patched range while the tree quietly
 * resolves 2.2.0 underneath platform-express. So it asks the module resolver,
 * from platform-express's own directory, which is the question that matters.
 */
describe("the multer that actually serves uploads is the patched one", () => {
  const MINIMUM = [2, 3, 0]; // the advisory floor: DoS via crafted field names

  function resolvedMulterVersion(from: string): number[] {
    const dir = dirname(require.resolve(from));
    const pkg = require.resolve("multer/package.json", { paths: [dir] });
    const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
    return version.split(".").map(Number);
  }

  function atLeast(actual: number[], floor: number[]): boolean {
    for (let i = 0; i < floor.length; i++) {
      if ((actual[i] ?? 0) > floor[i]) return true;
      if ((actual[i] ?? 0) < floor[i]) return false;
    }
    return true;
  }

  it("resolves >= 2.3.0 from @nestjs/platform-express, not just at the top level", () => {
    // The top-level copy was never the problem; this is the one FileInterceptor uses.
    expect(atLeast(resolvedMulterVersion("@nestjs/platform-express"), MINIMUM)).toBe(true);
  });

  it("resolves >= 2.3.0 at the top level too, so both copies agree", () => {
    expect(atLeast(resolvedMulterVersion("multer"), MINIMUM)).toBe(true);
  });

  it("keeps the override that makes the first case true", () => {
    // platform-express pins "2.2.0" exactly, so nothing but an override reaches it.
    const pkg = JSON.parse(src("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides?.multer).toBeDefined();
  });

  it("proves the comparator can fail, so the three cases above mean something", () => {
    // Without this, a comparator bug that returns true for everything would make
    // the whole block vacuous and indistinguishable from a genuine pass.
    expect(atLeast([2, 2, 0], MINIMUM)).toBe(false);
    expect(atLeast([1, 9, 9], MINIMUM)).toBe(false);
    expect(atLeast([2, 3, 0], MINIMUM)).toBe(true);
    expect(atLeast([3, 0, 0], MINIMUM)).toBe(true);
  });
});
