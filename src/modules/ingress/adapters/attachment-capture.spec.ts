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

  /**
   * A size nobody declared is unknown, not zero. Counting it as zero let it
   * past the per-file ceiling, spend none of the message's budget, and carry
   * every following attachment through with it — so the 25MB hard ceiling was
   * enforced against nothing at all for any provider that omits the field, as
   * Gmail's attachment list does for every attachment it returns.
   */
  it("refuses one whose size the provider did not declare", () => {
    for (const sizeBytes of [null, undefined]) {
      expect(decideAttachment(file({ sizeBytes }), "org-1", "msg-1", 0)).toEqual({
        capture: false,
        reason: "size-unknown",
      });
    }
  });

  it("does not let undeclared sizes spend the message budget", () => {
    // The failure this replaces: every unsized attachment captured, none of the
    // 50MB spent, so nothing after them was ever refused either.
    const unsized = file({ sizeBytes: null });
    expect(decideAttachment(unsized, "org-1", "msg-1", MAX_TOTAL_BYTES - 1).capture).toBe(false);
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

  /**
   * Everything made only of dots sanitised to the empty string, so `.`, `..`
   * and `...` were one key with an empty path segment in the middle of it —
   * distinct messages colliding onto a single object, which is the one thing
   * this key exists to prevent.
   */
  it("keeps degenerate identifiers distinct instead of collapsing them onto one key", () => {
    const keys = [".", "..", "...", ".....", ""].map((id) =>
      attachmentKey("org-1", id, "att-1", "contract.pdf"),
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).not.toContain("//");
      expect(key).not.toContain("..");
    }
  });

  it("is still stable for a degenerate identifier, so a replay overwrites", () => {
    expect(attachmentKey("org-1", "..", "att-1", "f.pdf")).toBe(
      attachmentKey("org-1", "..", "att-1", "f.pdf"),
    );
  });

  /**
   * The organisation is the tenant boundary of this key and `organizations.id`
   * is a bare `text` column, so it goes through the same sanitiser as anything
   * else somebody could have written.
   */
  it("sanitises the organisation, not just the parts that came from the email", () => {
    const key = attachmentKey("../../other-org", "msg-1", "att-1", "contract.pdf");
    expect(key.startsWith("crm-mail/")).toBe(true);
    expect(key).not.toContain("..");
    expect(key).not.toContain("//");
    expect(key).not.toBe(attachmentKey("other-org", "msg-1", "att-1", "contract.pdf"));
  });
});

describe("bytesFor", () => {
  /**
   * Nothing undeclared is ever stored — `decideAttachment` refuses it — so
   * nothing undeclared contributes to what storing the set would cost.
   */
  it("totals the declared sizes, which is all that can be stored", () => {
    expect(bytesFor([file({ sizeBytes: 100 }), file({ sizeBytes: null })])).toBe(100);
  });
});
