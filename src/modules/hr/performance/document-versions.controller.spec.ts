import { ForbiddenException } from "@nestjs/common";
import { DocumentVersionsController } from "./document-versions.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

const ORG_ID = "org-versions-controller";
const DOCUMENT_ID = 31;

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-hr",
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess",
  tokenScopes: null,
  principal: humanSessionPrincipal(51, false),
  ...overrides,
});

function build(view: DataScope, manage: DataScope) {
  const versions = {
    list: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    upload: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    approve: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
  };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, DataScope>([["hr:documents:view", view], ["hr:documents:manage", manage]])),
  };
  return { controller: new DocumentVersionsController(versions as never, access as never), versions };
}

describe("document versions controller", () => {
  describe.each<DataScope>(["own", "team", "none"])("a caller whose document scope is %s", (scope) => {
    it("cannot read a document's history, and the service is not reached", async () => {
      const { controller, versions } = build(scope, "all");

      await expect(controller.list(DOCUMENT_ID, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
      expect(versions.list).not.toHaveBeenCalled();
    });

    it("cannot upload a version, and the service is not reached", async () => {
      const { controller, versions } = build("all", scope);

      await expect(controller.upload(DOCUMENT_ID, { fileUrl: "k" }, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
      expect(versions.upload).not.toHaveBeenCalled();
    });
  });

  it("lets a caller with organisation-wide access read and upload, as the caller from the session", async () => {
    const { controller, versions } = build("all", "all");
    const actor = { userId: "user-hr", orgId: ORG_ID, membershipId: 51 };

    await controller.list(DOCUMENT_ID, makeUser());
    await controller.upload(DOCUMENT_ID, { fileUrl: "k" }, makeUser());

    expect(versions.list).toHaveBeenCalledWith(ORG_ID, DOCUMENT_ID);
    expect(versions.upload).toHaveBeenCalledWith(actor, DOCUMENT_ID, { fileUrl: "k" });
  });

  it("approves as the caller from the session (the publish permission is enforced by the route)", async () => {
    const { controller, versions } = build("none", "none");

    await controller.approve(DOCUMENT_ID, 2, makeUser());

    expect(versions.approve).toHaveBeenCalledWith({ userId: "user-hr", orgId: ORG_ID, membershipId: 51 }, DOCUMENT_ID, 2);
  });
});
