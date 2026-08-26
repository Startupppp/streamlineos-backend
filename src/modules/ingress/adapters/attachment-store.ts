import type { StorageService } from "../../storage/storage.service";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_BYTES,
  attachmentKey,
  decideAttachment,
  type MailAttachment,
} from "./attachment-capture";

/**
 * Fetches one attachment's bytes from the provider.
 *
 * Supplied by the caller rather than reached for here, because this module must
 * not know which provider it is talking to — that is the whole reason the
 * ingress seam exists.
 */
export type AttachmentBytes = (attachment: MailAttachment) => Promise<Buffer>;

export interface StoredAttachment {
  readonly attachmentId: string;
  readonly key: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/**
 * Why one attachment was not stored.
 *
 * The decision layer's reasons, plus the one only this half can produce: the
 * provider agreed the file existed and then would not hand it over.
 */
export type SkipReason =
  | "inline"
  | "too-large"
  | "budget-spent"
  | "no-name"
  | "size-unknown"
  | "fetch-failed";

export interface SkippedAttachment {
  readonly attachmentId: string;
  readonly reason: SkipReason;
}

export interface StoreAttachmentsInput {
  readonly organizationId: string;
  readonly providerMessageId: string;
  readonly attachments: readonly MailAttachment[];
  readonly fetch: AttachmentBytes;
}

export interface StoreAttachmentsResult {
  readonly stored: readonly StoredAttachment[];
  readonly skipped: readonly SkippedAttachment[];
}

/** Where an organisation's mail attachments live. */
const FOLDER = "crm-mail-attachments";

/**
 * Stores the attachments on one message, in the organisation's own region.
 *
 * `attachment-capture` decides; this spends the bytes. The split matters because
 * the decision is pure and testable against provider metadata, while this half
 * has to survive that metadata being wrong.
 *
 * **The declared size is a claim, not a measurement.** It arrives with mail
 * somebody else sent, and Gmail's attachment listing omits it entirely. So both
 * ceilings are enforced a second time against the bytes that actually arrive:
 * `decideAttachment` refuses what it can see is too big, and anything that gets
 * past it on a false or absent number is refused here once the real length is
 * known. Believing the claim is how a 25MB ceiling stores a 200MB file.
 *
 * **The budget is spent on real bytes too.** A message whose parts each claim a
 * kilobyte and each deliver twenty megabytes would otherwise pass a per-message
 * budget that was only ever checked against the claims.
 *
 * **One failure does not cost the message.** The caller is a sweep over a
 * mailbox; a provider 404 on one part is not a reason to lose the others, and
 * an exception here would stop the sweep for every message behind it.
 *
 * Keys come from `attachmentKey`, so re-delivering a message overwrites rather
 * than duplicating.
 */
export async function storeAttachments(
  storage: StorageService,
  input: StoreAttachmentsInput,
): Promise<StoreAttachmentsResult> {
  const stored: StoredAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  let spent = 0;

  for (const attachment of input.attachments) {
    const decision = decideAttachment(
      attachment,
      input.organizationId,
      input.providerMessageId,
      spent,
    );
    if (!decision.capture) {
      skipped.push({ attachmentId: attachment.id, reason: decision.reason });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await input.fetch(attachment);
    } catch {
      // Named, not thrown: the sweep behind this must keep going.
      skipped.push({ attachmentId: attachment.id, reason: "fetch-failed" });
      continue;
    }

    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      skipped.push({ attachmentId: attachment.id, reason: "too-large" });
      continue;
    }
    if (spent + bytes.length > MAX_TOTAL_BYTES) {
      skipped.push({ attachmentId: attachment.id, reason: "budget-spent" });
      continue;
    }

    const key = attachmentKey(
      input.organizationId,
      input.providerMessageId,
      attachment.id,
      attachment.fileName,
    );
    const mimeType = attachment.mimeType ?? "application/octet-stream";

    // `organizationId` first: this is ticket 03's seam, and it is what puts the
    // file in the tenant's own region rather than the deployment's primary.
    await storage.uploadFile(input.organizationId, bytes, FOLDER, key, mimeType);

    spent += bytes.length;
    stored.push({
      attachmentId: attachment.id,
      key,
      fileName: attachment.fileName,
      mimeType,
      sizeBytes: bytes.length,
    });
  }

  return { stored, skipped };
}
