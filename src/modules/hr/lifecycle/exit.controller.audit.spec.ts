import { ExitController } from "./exit.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-exit-audit";
const USER_ID = "user-exit-audit";
const RESIGNATION_ID = 42;
const FILE_URL = "https://example.com/resignation.pdf";
const FILE_KEY = `${ORG_ID}/resignations/resignation.pdf`;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "sess-exit",
    tokenScopes: null,
    principal: humanSessionPrincipal(10, false),
    ...overrides,
  };
}

describe("ExitController.getUploadedLetter — audit written outside the request transaction", () => {
  it("records the resignation letter view outside the request transaction, because a GET holds no mutation to commit with and a read-intent transaction must not write", async () => {
    const record = { id: RESIGNATION_ID, fileUrl: FILE_URL };
    const exit = { getFileReference: jest.fn().mockResolvedValue(record) };
    const storage = {
      getFileKeyFromUrl: jest.fn().mockReturnValue(FILE_KEY),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/resignation.pdf"),
    };
    const audit = {
      logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
      logCritical: jest.fn(),
    };
    const access = { resolveUserPermissions: jest.fn() };

    const controller = new ExitController(
      exit as never,
      undefined as never,
      undefined as never,
      undefined as never,
      access as never,
      storage as never,
      audit as never,
    );

    const result = await controller.getUploadedLetter(RESIGNATION_ID, makeUser());

    expect(result).toEqual({ url: "https://signed.example.com/resignation.pdf", expiresIn: 300 });
    expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.resignation_letter_viewed",
        userId: USER_ID,
        orgId: ORG_ID,
        targetId: String(RESIGNATION_ID),
        targetType: "resignation",
      }),
    );
    expect(audit.logCritical).not.toHaveBeenCalled();
  });
});
