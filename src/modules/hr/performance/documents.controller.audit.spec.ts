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
    const docRef = { documentId: DOCUMENT_ID, fileUrl: FILE_URL, fileName: "contract.pdf" };
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
});
