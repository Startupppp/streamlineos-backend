import { BadRequestException, UnsupportedMediaTypeException } from "@nestjs/common";
import { sendMessageSchema } from "../chat/dto/chat.schemas";
import { addVaultDocumentSchema } from "../hr/recruitment/dto/candidate-records.schemas";
import { createKbAttachmentSchema } from "../support/core/dto/support-kb.schemas";
import { RecruitmentCandidateVaultService } from "../hr/recruitment/recruitment-candidate-vault.service";
import { SupportKbEngagementService } from "../support/core/support-kb-engagement.service";
import type { Db } from "../../db/drizzle.module";

const cleanQuarantine = {
  getStatusForKey: async () => "clean" as const,
} as unknown as import("./file-quarantine.service").FileQuarantineService;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const HOSTILE_KEYS = [
  `${ORG_A}/../${ORG_B}/documents/payslip.pdf`,
  `/${ORG_A}/documents/payslip.pdf`,
  "https://attacker.example/payload.pdf",
  `${ORG_A}/documents/a.pdf?x=1`,
  `${ORG_A}/documents/a.pdf#frag`,
  `${ORG_A}\\documents\\a.pdf`,
];

/**
 * PRD-C103: "use organization-scoped object keys".
 *
 * Three routes store an object key with no bytes passing through them — a chat
 * attachment, a candidate vault record and a KB article attachment. On all
 * three the key is a client string, so it is an input to be validated and not a
 * fact to be trusted. Left unconstrained the stored row becomes a pointer at
 * whatever object the caller could spell, and the read paths authorise the ROW
 * and then sign the key it carries.
 */
describe("client-supplied object keys are constrained at the schema boundary", () => {
  it("chat rejects a hostile attachment key", () => {
    for (const fileKey of HOSTILE_KEYS) {
      const parsed = sendMessageSchema.safeParse({
        content: "hi",
        attachments: [
          { fileName: "a.pdf", fileUrl: "u", fileKey, fileSize: 1, mimeType: "application/pdf" },
        ],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("chat still accepts a well-formed key (control)", () => {
    const parsed = sendMessageSchema.safeParse({
      content: "hi",
      attachments: [
        {
          fileName: "a.pdf",
          fileUrl: "u",
          fileKey: `${ORG_A}/chat/1-a.pdf`,
          fileSize: 1,
          mimeType: "application/pdf",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("the candidate vault rejects a hostile s3Key", () => {
    for (const s3Key of HOSTILE_KEYS) {
      const parsed = addVaultDocumentSchema.safeParse({
        filename: "a.pdf",
        s3Key,
        fileUrl: "https://files.example.com/a.pdf",
        fileType: "application/pdf",
        fileSize: 1,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("the KB attachment route rejects a hostile fileKey", () => {
    for (const fileKey of HOSTILE_KEYS) {
      const parsed = createKbAttachmentSchema.safeParse({
        fileName: "a.pdf",
        fileKey,
        fileSize: 1,
        mimeType: "application/pdf",
      });
      expect(parsed.success).toBe(false);
    }
  });
});

/**
 * The schema constrains the key's SHAPE; only the service knows the tenant, so
 * the organisation prefix has to be asserted there. `chat-messages.service.ts`
 * already did this; the vault and the KB attachment route did not.
 */
describe("client-supplied object keys are bound to the caller's tenant at the service", () => {
  function vaultDb(): Db {
    return {
      query: {
        candidates: { findFirst: async () => ({ id: 7 }) },
        candidateDocumentsVault: { findFirst: async () => undefined },
      },
      insert: () => ({ values: () => ({ returning: async () => [{ id: 1 }] }) }),
    } as unknown as Db;
  }

  const VALID_VAULT_INPUT = {
    filename: "offer.pdf",
    s3Key: `${ORG_A}/candidate-vault/1-offer.pdf`,
    fileUrl: "https://files.example.com/a.pdf",
    fileType: "application/pdf",
    fileSize: 10,
  };

  it("the vault refuses a key naming another organisation", async () => {
    const svc = new RecruitmentCandidateVaultService(vaultDb(), cleanQuarantine);
    await expect(
      svc.addVaultDocument(ORG_A, "user-1", 7, {
        ...VALID_VAULT_INPUT,
        s3Key: `${ORG_B}/candidate-vault/1-offer.pdf`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the vault refuses a legacy key that names no organisation at all", async () => {
    const svc = new RecruitmentCandidateVaultService(vaultDb(), cleanQuarantine);
    await expect(
      svc.addVaultDocument(ORG_A, "user-1", 7, {
        ...VALID_VAULT_INPUT,
        s3Key: "candidate-vault/1-offer.pdf",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the vault accepts the caller's own key (control)", async () => {
    const svc = new RecruitmentCandidateVaultService(vaultDb(), cleanQuarantine);
    await expect(
      svc.addVaultDocument(ORG_A, "user-1", 7, VALID_VAULT_INPUT),
    ).resolves.toEqual({ id: 1 });
  });

  /**
   * The declared MIME and the filename extension were checked with OR, so a
   * caller supplied ONE of them and skipped the other: `application/pdf` on
   * `payload.html`, or `payload.pdf` declared `text/html`. Only the conjunction
   * constrains anything.
   */
  it("the vault requires the declared MIME AND the extension to agree with the allowlist", async () => {
    const svc = new RecruitmentCandidateVaultService(vaultDb(), cleanQuarantine);
    await expect(
      svc.addVaultDocument(ORG_A, "user-1", 7, {
        ...VALID_VAULT_INPUT,
        filename: "payload.html",
        fileType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(
      svc.addVaultDocument(ORG_A, "user-1", 7, {
        ...VALID_VAULT_INPUT,
        filename: "payload.pdf",
        fileType: "text/html",
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  function kbDb(): Db {
    return {
      query: { kbArticles: { findFirst: async () => ({ id: 42 }) } },
      insert: () => ({ values: () => ({ returning: async () => [{ id: 1 }] }) }),
    } as unknown as Db;
  }

  const VALID_KB_INPUT = {
    fileName: "a.pdf",
    fileKey: `${ORG_A}/kb-attachments/1-a.pdf`,
    fileSize: 1,
    mimeType: "application/pdf" as const,
  };

  it("the KB attachment route refuses a key naming another organisation", async () => {
    const svc = new SupportKbEngagementService(kbDb(), {} as never);
    await expect(
      svc.createAttachment(ORG_A, 42, "user-1", {
        ...VALID_KB_INPUT,
        fileKey: `${ORG_B}/kb-attachments/1-a.pdf`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the KB attachment route accepts the caller's own key (control)", async () => {
    const svc = new SupportKbEngagementService(kbDb(), {} as never);
    await expect(
      svc.createAttachment(ORG_A, 42, "user-1", VALID_KB_INPUT),
    ).resolves.toEqual({ id: 1 });
  });
});
