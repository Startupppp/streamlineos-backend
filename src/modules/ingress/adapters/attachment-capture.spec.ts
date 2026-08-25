import {
  attachmentKey,
  bytesFor,
  decideAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_BYTES,
  type MailAttachment,
} from "./attachment-capture";

const file = (over: Partial<MailAttachment> = {}): MailAttachment => ({
  id: "att-1",
  fileName: "contract.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  inline: false,
  ...over,
});

describe("decideAttachment", () => {
  it("captures an ordinary attachment", () => {
    const result = decideAttachment(file(), "org-1", "msg-1", 0);
    expect(result).toMatchObject({ capture: true });
  });

  /**
   * Inline images are the signature block and the tracking pixel. Storing them
   * fills a bucket with logos and tells a reader nothing.
   */
  it("skips inline images", () => {
    expect(decideAttachment(file({ inline: true }), "org-1", "msg-1", 0)).toEqual({
      capture: false,
      reason: "inline",
    });
  });

  it("skips one too large to be worth the storage", () => {
    // Skipped rather than truncated: half a file is a corrupt file that looks
    // like a real one.
    const huge = file({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 });
    expect(decideAttachment(huge, "org-1", "msg-1", 0)).toEqual({
      capture: false,
      reason: "too-large",
    });
  });

  it("enforces a budget across the whole message, not just per file", () => {
    // Ten 6MB files are the problem a per-file limit does not catch.
    const each = file({ sizeBytes: 6 * 1024 * 1024 });
    expect(decideAttachment(each, "org-1", "msg-1", MAX_TOTAL_BYTES - 1024).capture).toBe(false);
    expect(decideAttachment(each, "org-1", "msg-1", 0).capture).toBe(true);
  });

  it("skips one with no name to store it under", () => {
    expect(decideAttachment(file({ fileName: "  " }), "org-1", "msg-1", 0)).toEqual({
      capture: false,
      reason: "no-name",
    });
  });
});

describe("attachmentKey", () => {
  it("namespaces by organisation first, so a listing is scoped by prefix", () => {
    expect(attachmentKey("org-1", "msg-1", "att-1", "contract.pdf")).toMatch(/^crm-mail\/org-1\//);
  });

  /**
   * Two people receiving the same file must not collide, and the same message
   * re-delivered must land on the same key so a replay overwrites rather than
   * duplicates.
   */
  it("is stable for the same message and attachment", () => {
    expect(attachmentKey("org-1", "msg-1", "att-1", "contract.pdf")).toBe(
      attachmentKey("org-1", "msg-1", "att-1", "contract.pdf"),
    );
  });

  it("separates the same filename across messages and organisations", () => {
    const a = attachmentKey("org-1", "msg-1", "att-1", "contract.pdf");
    expect(a).not.toBe(attachmentKey("org-1", "msg-2", "att-1", "contract.pdf"));
    expect(a).not.toBe(attachmentKey("org-2", "msg-1", "att-1", "contract.pdf"));
  });

  it("strips anything that could escape the prefix", () => {
    // A filename is attacker-controlled: it came from an email.
    const key = attachmentKey("org-1", "../../etc", "a/../b", "../../../passwd");
    expect(key).not.toContain("..");
    expect(key.startsWith("crm-mail/org-1/")).toBe(true);
  });

  it("bounds a filename somebody made absurdly long", () => {
    expect(attachmentKey("org-1", "m", "a", "x".repeat(500)).length).toBeLessThan(300);
  });
});

describe("bytesFor", () => {
  it("totals a set, treating an unknown size as nothing", () => {
    expect(bytesFor([file({ sizeBytes: 100 }), file({ sizeBytes: null })])).toBe(100);
  });
});
