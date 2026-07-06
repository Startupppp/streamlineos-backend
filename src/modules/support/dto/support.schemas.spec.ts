import { replyMessageSchema } from "./support.schemas";

function baseMessage(overrides: Record<string, unknown> = {}) {
  return { body: "hello", isInternal: false, ...overrides };
}

describe("replyMessageSchema — attachment validation", () => {
  it("accepts a message with no attachments", () => {
    expect(replyMessageSchema.safeParse(baseMessage()).success).toBe(true);
  });

  it("accepts a valid attachment", () => {
    const result = replyMessageSchema.safeParse(
      baseMessage({
        attachments: [
          { fileName: "receipt.pdf", fileUrl: "https://cdn.example.com/receipt.pdf", fileSize: 1024, mimeType: "application/pdf" },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an attachment exceeding the max file size", () => {
    const result = replyMessageSchema.safeParse(
      baseMessage({
        attachments: [
          {
            fileName: "huge.pdf",
            fileUrl: "https://cdn.example.com/huge.pdf",
            fileSize: 11 * 1024 * 1024,
            mimeType: "application/pdf",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a disallowed mime type", () => {
    const result = replyMessageSchema.safeParse(
      baseMessage({
        attachments: [
          {
            fileName: "script.exe",
            fileUrl: "https://cdn.example.com/script.exe",
            fileSize: 1024,
            mimeType: "application/x-msdownload",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative or zero file size", () => {
    const result = replyMessageSchema.safeParse(
      baseMessage({
        attachments: [
          { fileName: "a.png", fileUrl: "https://cdn.example.com/a.png", fileSize: 0, mimeType: "image/png" },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an empty file name", () => {
    const result = replyMessageSchema.safeParse(
      baseMessage({
        attachments: [{ fileName: "  ", fileUrl: "https://cdn.example.com/a.png", fileSize: 100, mimeType: "image/png" }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects more than 10 attachments", () => {
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      fileName: `file${i}.png`,
      fileUrl: `https://cdn.example.com/file${i}.png`,
      fileSize: 100,
      mimeType: "image/png",
    }));
    const result = replyMessageSchema.safeParse(baseMessage({ attachments }));
    expect(result.success).toBe(false);
  });
});
