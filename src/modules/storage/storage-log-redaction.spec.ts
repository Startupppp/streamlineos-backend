import { readFileSync } from "fs";
import { join } from "path";
import { redact } from "../../common/observability/redact";

/**
 * The antivirus, compression and multipart paths used to interpolate the
 * uploaded filename and the object key straight into the log message. The
 * redactor is key-based — it withholds values by field name inside `meta` — so
 * anything already baked into the message string walks past it. These pin the
 * difference, and the third case is the failure mode the call sites moved away
 * from.
 */
describe("upload seam — a tenant filename never reaches a log line", () => {
  it("withholds the params carrier the Nest logger adapter builds from an extra object argument", () => {
    const meta = { context: "AvScanner", params: [{ filename: "Priya Sharma - Aadhaar.pdf" }] };
    expect(JSON.stringify(redact(meta))).not.toContain("Priya");
  });

  it("withholds a filename passed directly as a meta key", () => {
    expect(JSON.stringify(redact({ filename: "Priya Sharma - Aadhaar.pdf" }))).not.toContain("Priya");
  });

  it("does NOT withhold it when it is baked into the message string — the reason these call sites moved", () => {
    const message = 'File "Priya Sharma - Aadhaar.pdf" uploaded without malware scan';
    expect(String(redact(message))).toContain("Priya");
  });
});

/**
 * The three cases above prove WHY the message string is the wrong carrier. This
 * one proves the upload seam still obeys it, because a proof about `redact`
 * cannot notice a new call site that bypasses it.
 *
 * `check:log-secrets` compares the redactor's field list against the code; it
 * reads structured fields and therefore cannot see inside an interpolated
 * message, which is exactly where the leak hides. A video-transcode warning
 * carrying `Video transcode for "${fileName}"` sat here green under that gate
 * until this scan was written.
 */
describe("upload seam — no logger MESSAGE interpolates a tenant filename or object key", () => {
  const BACKEND_SRC = join(__dirname, "..", "..");

  const SCANNED_FILES = [
    "common/security/av-scan.ts",
    "common/security/virustotal-av-scanner.ts",
    "common/security/clamd-av-scanner.ts",
    "common/media/media-compression.service.ts",
    "modules/storage/storage.controller.ts",
    "modules/storage/storage-onboarding.controller.ts",
    "modules/storage/storage-multipart.service.ts",
    "modules/storage/media-transform.runner.ts",
    "modules/cron/cron-storage-sweep.service.ts",
  ];

  /**
   * Matches a logger call whose FIRST argument is a template literal, then looks
   * for a tenant identifier interpolated into it. `${String(err)}` and
   * `${err.message}` are diagnostics about the failure, not about the tenant's
   * file, and stay in the message on purpose.
   */
  const LOGGER_TEMPLATE_MESSAGE =
    /\.(?:log|warn|error|debug|verbose)\(\s*`((?:[^`\\]|\\.)*)`/gs;
  const TENANT_IDENTIFIER =
    /\$\{[^}]*\b(?:fileName|filename|originalname|originalName|storageKey|fileKey|objectKey)\b[^}]*\}/;

  it.each(SCANNED_FILES)("%s keeps tenant identifiers out of the message string", (relative) => {
    const source = readFileSync(join(BACKEND_SRC, relative), "utf8");
    const offenders: string[] = [];

    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    for (const match of source.matchAll(LOGGER_TEMPLATE_MESSAGE)) {
      const message = match[1] ?? "";
      if (TENANT_IDENTIFIER.test(message)) offenders.push(message);
    }

    expect(offenders).toEqual([]);
  });

  it("the scan bites — a message interpolating a filename is detected", () => {
    const bad = 'this.logger.warn(`Video transcode for "${fileName}" produced no saving`);';
    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    const found = [...bad.matchAll(LOGGER_TEMPLATE_MESSAGE)].filter((m) =>
      TENANT_IDENTIFIER.test(m[1] ?? ""),
    );
    expect(found).toHaveLength(1);
  });

  it("the scan does not flag an error diagnostic that carries no tenant identifier", () => {
    const good = 'this.logger.warn(`Video transcode failed, storing original: ${String(err)}`, { fileName });';
    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    const found = [...good.matchAll(LOGGER_TEMPLATE_MESSAGE)].filter((m) =>
      TENANT_IDENTIFIER.test(m[1] ?? ""),
    );
    expect(found).toHaveLength(0);
  });
});
