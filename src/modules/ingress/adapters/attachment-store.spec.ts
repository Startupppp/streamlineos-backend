import { storeAttachments, type AttachmentBytes } from "./attachment-store";
import { MAX_ATTACHMENT_BYTES, type MailAttachment } from "./attachment-capture";
import type { StorageService } from "../../storage/storage.service";

/**
 * Storing what `attachment-capture` decided to keep.
 *
 * The decision layer is deliberately pure — it reads provider metadata and says
 * yes or no. This is the half that spends bytes, and the two failure modes it
 * has to survive are both about trusting that metadata:
 *
 * The size on an attachment is a **claim made by whoever sent the mail**. A
 * provider that omits it, or a sender who lies about it, must not be able to
 * turn the ceiling off — so the cap is enforced against the bytes as they
 * arrive, not against the number that came with them. `attachment-capture`'s
 * own doc says exactly this and leaves it to whoever wires it up.
 *
 * And every write goes through the organisation's region, because an
 * attachment is customer correspondence and it belongs where the rest of that
 * tenant's data is.
 */
describe("storeAttachments", () => {
  const ORG = "org-eu";
  const MSG = "provider-message-1";

  const uploads: { orgId: string; folder: string; fileName: string; bytes: number }[] = [];
  const storage = {
    uploadFile: async (
      orgId: string,
      buffer: Buffer,
      folder: string,
      fileName: string,
    ) => {
      uploads.push({ orgId, folder, fileName, bytes: buffer.length });
      return { url: "", key: `${folder}/${fileName}`, size: buffer.length, mimeType: "" };
    },
  } as unknown as StorageService;

  beforeEach(() => {
    uploads.length = 0;
  });

  const attachment = (over: Partial<MailAttachment> = {}): MailAttachment => ({
    id: "att-1",
    fileName: "quote.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1_000,
    inline: false,
    ...over,
  });

  const bytes = (n: number): AttachmentBytes => async () => Buffer.alloc(n, 1);

  it("stores a kept attachment in the organisation's own region", async () => {
    const result = await storeAttachments(storage, {
      organizationId: ORG,
      providerMessageId: MSG,
      attachments: [attachment()],
      fetch: bytes(1_000),
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.orgId).toBe(ORG);
    expect(result.stored).toHaveLength(1);
  });

  it("never downloads what the decision layer refused", async () => {
    const fetchSpy = jest.fn(bytes(10));

    const result = await storeAttachments(storage, {
      organizationId: ORG,
      providerMessageId: MSG,
      attachments: [attachment({ inline: true })],
      fetch: fetchSpy,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "inline" });
  });

  /**
   * The case the declared size cannot catch. A sender says 1KB and delivers
   * 30MB; believing the claim would store it.
   */
  it("refuses a file whose real size exceeds the ceiling its metadata claimed", async () => {
    const result = await storeAttachments(storage, {
      organizationId: ORG,
      providerMessageId: MSG,
      attachments: [attachment({ sizeBytes: 1_000 })],
      fetch: bytes(MAX_ATTACHMENT_BYTES + 1),
    });

    expect(uploads).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "too-large" });
  });

  it("spends the message budget on real bytes, not claimed ones", async () => {
    // Each claims a kilobyte and each delivers twenty megabytes. Under the
    // per-file ceiling every time, so only a budget counted against real bytes
    // stops the third.
    const twentyMb = 20 * 1024 * 1024;
    const result = await storeAttachments(storage, {
      organizationId: ORG,
      providerMessageId: MSG,
      attachments: [
        attachment({ id: "a", fileName: "one.pdf", sizeBytes: 1_000 }),
        attachment({ id: "b", fileName: "two.pdf", sizeBytes: 1_000 }),
        attachment({ id: "c", fileName: "three.pdf", sizeBytes: 1_000 }),
      ],
      fetch: bytes(twentyMb),
    });

    expect(result.stored).toHaveLength(2);
    expect(result.skipped).toEqual([{ attachmentId: "c", reason: "budget-spent" }]);
  });

  /**
   * One failing download must not cost the rest of the message. A sweep is the
   * caller, and a provider 404 on one part is not a reason to lose the others.
   */
  it("keeps going when one download fails", async () => {
    const result = await storeAttachments(storage, {
      organizationId: ORG,
      providerMessageId: MSG,
      attachments: [
        attachment({ id: "a", fileName: "one.pdf" }),
        attachment({ id: "b", fileName: "two.pdf" }),
      ],
      fetch: async (att) => {
        if (att.id === "a") throw new Error("provider said no");
        return Buffer.alloc(10, 1);
      },
    });

    expect(result.stored).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reason: "fetch-failed" });
  });

  it("puts the same message's attachment on the same key twice, so a replay overwrites", async () => {
    const once = async () =>
      storeAttachments(storage, {
        organizationId: ORG,
        providerMessageId: MSG,
        attachments: [attachment()],
        fetch: bytes(100),
      });

    const a = await once();
    const b = await once();

    expect(a.stored[0]!.key).toBe(b.stored[0]!.key);
  });
});
