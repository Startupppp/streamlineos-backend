import { DocumentsController } from "./documents.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-docs-audit";
const USER_ID = "user-docs-audit";
const DOCUMENT_ID = 77;
const FILE_URL = "https://example.com/contract.pdf";
const FILE_KEY = `${ORG_ID}/documents/contract.pdf`;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "sess-docs",
    tokenScopes: null,
    principal: humanSessionPrincipal(20, false),
    ...overrides,
  };
}

describe("DocumentsController.getDocumentFile — audit written outside the request transaction", () => {
  it("records the document view outside the request transaction, because a GET holds no mutation and writing inside a read-intent transaction blocks read-only transaction mode and read-replica routing", async () => {
    const docRef = { documentId: DOCUMENT_ID, fileUrl: FILE_URL, fileName: "contract.pdf", ownerUserId: null, classification: "INTERNAL" };
    const documents = {
      getFileReference: jest.fn().mockResolvedValue(docRef),
    };
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:documents:view", "all"]])),
    };
    const storage = {
      getFileKeyFromUrl: jest.fn().mockReturnValue(FILE_KEY),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/contract.pdf"),
    };
    const audit = {
      logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
      logCritical: jest.fn(),
    };

    const controller = new DocumentsController(
      documents as never,
      undefined as never,
      undefined as never,
      undefined as never,
      access as never,
      storage as never,
      audit as never,
    );

    const result = await controller.getDocumentFile(DOCUMENT_ID, makeUser());

    expect(result).toEqual({
      url: "https://signed.example.com/contract.pdf",
      fileName: "contract.pdf",
      expiresIn: 300,
    });
    expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.document_viewed",
        userId: USER_ID,
        orgId: ORG_ID,
        targetId: String(DOCUMENT_ID),
        targetType: "document",
      }),
    );
    expect(audit.logCritical).not.toHaveBeenCalled();
  });

  /**
   * V-148. Every view was already audited, but the row said nothing about WHOSE document it was, so an
   * administrator opening an employee's personal file read exactly like the employee opening their own — and
   * that is the only one of the two anybody would ever go looking for. The predicate is recorded, not enforced:
   * both views are allowed, and the audit row is what makes them distinguishable afterwards.
   */
  describe.each([
    ["someone else's personal document", "user-employee", false],
    ["the caller's own document", USER_ID, true],
  ])("viewing %s", (_case, ownerUserId, actorIsOwner) => {
    it(`records actorIsOwner ${String(actorIsOwner)} and the classification, and no URL`, async () => {
      const documents = {
        getFileReference: jest
          .fn()
          .mockResolvedValue({ documentId: DOCUMENT_ID, fileUrl: FILE_URL, fileName: "payslip.pdf", ownerUserId, classification: "PERSONAL" }),
      };
      const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:documents:view", "all"]])) };
      const storage = {
        getFileKeyFromUrl: jest.fn().mockReturnValue(FILE_KEY),
        isValidFileKey: jest.fn().mockReturnValue(true),
        getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/payslip.pdf?X-Amz-Signature=abc"),
      };
      const audit = { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined), logCritical: jest.fn() };
      const controller = new DocumentsController(
        documents as never,
        undefined as never,
        undefined as never,
        undefined as never,
        access as never,
        storage as never,
        audit as never,
      );

      await controller.getDocumentFile(DOCUMENT_ID, makeUser());

      const [row] = audit.logCriticalOutsideTransaction.mock.calls[0] as [{ metadata: Record<string, unknown> }];
      expect(row.metadata).toMatchObject({ actorIsOwner, documentIsOwned: true, classification: "PERSONAL" });
      // The audit row records that a file was opened, never the credential that opened it.
      expect(JSON.stringify(row)).not.toMatch(/X-Amz-Signature|https?:\/\//);
    });
  });
});
