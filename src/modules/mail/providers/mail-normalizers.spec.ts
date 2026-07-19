import {
  decodeCursor,
  encodeCursor,
  mergeMessagesByDate,
  normalizeGmailMessage,
  normalizeOutlookMessage,
  type NormalizerConnectionMeta,
} from "./mail-normalizers";

const gmailConn: NormalizerConnectionMeta = { id: 1, provider: "gmail", accountEmail: "user@gmail.com" };
const outlookConn: NormalizerConnectionMeta = { id: 2, provider: "outlook", accountEmail: "user@outlook.com" };

function makeGmailRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg1",
    threadId: "thread1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hello there",
    internalDate: "1700000000000",
    payload: {
      headers: [
        { name: "From", value: "Sender Name <sender@example.com>" },
        { name: "To", value: "me@gmail.com" },
        { name: "Subject", value: "Test subject" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Hello text").toString("base64url"), size: 10 } },
        { mimeType: "text/html", body: { data: Buffer.from("<p>Hello html</p>").toString("base64url"), size: 17 } },
      ],
    },
    ...overrides,
  };
}

function makeOutlookRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg2",
    conversationId: "conv1",
    subject: "Outlook subject",
    from: { emailAddress: { name: "Sender OL", address: "sender@outlook.com" } },
    toRecipients: [{ emailAddress: { name: "Me", address: "me@outlook.com" } }],
    isRead: false,
    flag: { flagStatus: "flagged" },
    receivedDateTime: "2024-01-15T10:00:00Z",
    hasAttachments: false,
    bodyPreview: "Preview text",
    body: { contentType: "html", content: "<p>Body HTML</p>" },
    ...overrides,
  };
}

describe("normalizeGmailMessage", () => {
  it("maps summary fields correctly", () => {
    const result = normalizeGmailMessage(makeGmailRaw(), gmailConn, false);
    expect(result.id).toBe("msg1");
    expect(result.threadId).toBe("thread1");
    expect(result.accountId).toBe(1);
    expect(result.provider).toBe("gmail");
    expect(result.from).toEqual({ name: "Sender Name", email: "sender@example.com" });
    expect(result.to).toEqual([{ name: null, email: "me@gmail.com" }]);
    expect(result.subject).toBe("Test subject");
    expect(result.isRead).toBe(false);
    expect(result.isStarred).toBe(false);
    expect(result.snippet).toBe("Hello there");
    expect(result.date).toBe(new Date(1700000000000).toISOString());
  });

  it("maps detail fields with html body", () => {
    const result = normalizeGmailMessage(makeGmailRaw(), gmailConn, true);
    expect(result.bodyHtml).toBe("<p>Hello html</p>");
    expect(result.bodyText).toBe("Hello text");
    expect(result.attachments).toEqual([]);
    expect(result.cc).toEqual([]);
  });

  it("marks isRead when UNREAD label is absent", () => {
    const raw = makeGmailRaw({ labelIds: ["INBOX"] });
    const result = normalizeGmailMessage(raw, gmailConn, false);
    expect(result.isRead).toBe(true);
  });

  it("marks isStarred when STARRED label is present", () => {
    const raw = makeGmailRaw({ labelIds: ["INBOX", "STARRED"] });
    const result = normalizeGmailMessage(raw, gmailConn, false);
    expect(result.isStarred).toBe(true);
  });

  it("extracts attachments in detail mode", () => {
    const raw = makeGmailRaw({
      payload: {
        headers: makeGmailRaw().payload.headers,
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("text").toString("base64url") } },
          {
            mimeType: "application/pdf",
            filename: "doc.pdf",
            body: { attachmentId: "att1", size: 1024 },
          },
        ],
      },
    });
    const result = normalizeGmailMessage(raw, gmailConn, true);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      id: "att1",
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    });
    expect(result.hasAttachments).toBe(true);
  });

  it("uses fallback subject when header is missing", () => {
    const raw = makeGmailRaw({
      payload: {
        headers: [{ name: "From", value: "a@b.com" }],
        mimeType: "text/plain",
        parts: [],
      },
    });
    const result = normalizeGmailMessage(raw, gmailConn, false);
    expect(result.subject).toBe("(no subject)");
  });
});

describe("normalizeOutlookMessage", () => {
  it("maps summary fields correctly", () => {
    const result = normalizeOutlookMessage(makeOutlookRaw(), outlookConn, false);
    expect(result.id).toBe("msg2");
    expect(result.threadId).toBe("conv1");
    expect(result.accountId).toBe(2);
    expect(result.provider).toBe("outlook");
    expect(result.from).toEqual({ name: "Sender OL", email: "sender@outlook.com" });
    expect(result.to).toEqual([{ name: "Me", email: "me@outlook.com" }]);
    expect(result.subject).toBe("Outlook subject");
    expect(result.isRead).toBe(false);
    expect(result.isStarred).toBe(true);
    expect(result.snippet).toBe("Preview text");
    expect(result.date).toBe("2024-01-15T10:00:00Z");
  });

  it("maps detail fields with body", () => {
    const result = normalizeOutlookMessage(makeOutlookRaw(), outlookConn, true);
    expect(result.bodyHtml).toBe("<p>Body HTML</p>");
    expect(result.bodyText).toBeNull();
    expect(result.attachments).toEqual([]);
  });

  it("maps outlook attachments in detail mode", () => {
    const attachments = [
      { id: "att2", name: "file.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 2048 },
    ];
    const result = normalizeOutlookMessage(makeOutlookRaw(), outlookConn, true, attachments);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ id: "att2", fileName: "file.docx", sizeBytes: 2048 });
  });

  it("uses fallback subject when null", () => {
    const raw = makeOutlookRaw({ subject: null });
    const result = normalizeOutlookMessage(raw, outlookConn, false);
    expect(result.subject).toBe("(no subject)");
  });

  it("handles unflagged status", () => {
    const raw = makeOutlookRaw({ flag: { flagStatus: "notFlagged" } });
    const result = normalizeOutlookMessage(raw, outlookConn, false);
    expect(result.isStarred).toBe(false);
  });
});

describe("cursor encode/decode roundtrip", () => {
  it("encodes and decodes a cursor map", () => {
    const cursor = { 1: "pageTokenABC", 2: 25 };
    const encoded = encodeCursor(cursor);
    expect(typeof encoded).toBe("string");
    const decoded = decodeCursor(encoded);
    expect(decoded[1]).toBe("pageTokenABC");
    expect(decoded[2]).toBe(25);
  });

  it("returns empty object for invalid cursor", () => {
    expect(decodeCursor("not-valid-base64url!!")).toEqual({});
  });

  it("returns empty object for non-object JSON", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2, 3]), "utf-8").toString("base64url");
    expect(decodeCursor(encoded)).toEqual({});
  });
});

describe("mergeMessagesByDate", () => {
  it("sorts messages by date descending", () => {
    const messages = [
      { ...makeOutlookRaw(), id: "a", date: "2024-01-10T00:00:00Z", accountId: 1, provider: "outlook" as const, from: { name: null, email: "" }, to: [], subject: "", snippet: "", isRead: true, isStarred: false, hasAttachments: false, threadId: null },
      { ...makeOutlookRaw(), id: "b", date: "2024-01-15T00:00:00Z", accountId: 1, provider: "outlook" as const, from: { name: null, email: "" }, to: [], subject: "", snippet: "", isRead: true, isStarred: false, hasAttachments: false, threadId: null },
      { ...makeOutlookRaw(), id: "c", date: "2024-01-12T00:00:00Z", accountId: 1, provider: "outlook" as const, from: { name: null, email: "" }, to: [], subject: "", snippet: "", isRead: true, isStarred: false, hasAttachments: false, threadId: null },
    ];
    const sorted = mergeMessagesByDate(messages);
    expect(sorted.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });
});
