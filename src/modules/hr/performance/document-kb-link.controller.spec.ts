import { ForbiddenException } from "@nestjs/common";
import { DocumentKbLinkController } from "./document-kb-link.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

const ORG_ID = "org-kb-link-controller";
const DOCUMENT_ID = 21;

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-hr",
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess",
  tokenScopes: null,
  principal: humanSessionPrincipal(41, false),
  ...overrides,
});

function build(view: DataScope) {
  const links = {
    getState: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    publish: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    updateLink: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    unpublish: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
  };
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, DataScope>([["hr:documents:view", view]])) };
  return { controller: new DocumentKbLinkController(links as never, access as never), links };
}

describe("document knowledge-base link controller", () => {
  describe.each<DataScope>(["own", "team", "none"])("a caller whose document scope is %s", (scope) => {
    it("cannot read where a document stands in the knowledge base, and the service is not reached", async () => {
      const { controller, links } = build(scope);

      await expect(controller.state(DOCUMENT_ID, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
      expect(links.getState).not.toHaveBeenCalled();
    });
  });

  it("reads for a caller with organisation-wide access, handing over only the tenant from the session", async () => {
    const { controller, links } = build("all");

    await controller.state(DOCUMENT_ID, makeUser());

    expect(links.getState).toHaveBeenCalledWith(ORG_ID, DOCUMENT_ID);
  });

  it("publishes, re-scopes and withdraws as the caller from the session, never as anyone the body names", async () => {
    const { controller, links } = build("none");
    const actor = { userId: "user-hr", orgId: ORG_ID, membershipId: 41 };

    await controller.publish(DOCUMENT_ID, { audiences: [{ kind: "ALL_EMPLOYEES" }] }, makeUser());
    await controller.update(DOCUMENT_ID, { versionMode: "FOLLOW_LATEST" }, makeUser());
    await controller.unpublish(DOCUMENT_ID, makeUser());

    expect(links.publish).toHaveBeenCalledWith(actor, DOCUMENT_ID, { audiences: [{ kind: "ALL_EMPLOYEES" }] });
    expect(links.updateLink).toHaveBeenCalledWith(actor, DOCUMENT_ID, { versionMode: "FOLLOW_LATEST" });
    expect(links.unpublish).toHaveBeenCalledWith(actor, DOCUMENT_ID);
  });
});
