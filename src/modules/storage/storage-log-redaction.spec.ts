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
