import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DocumentKbLinkController } from "./document-kb-link.controller";
import { DocumentAccessService } from "./document-access.service";
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


/**
 * The controllers no longer decide access themselves: they ask `DocumentAccessService`, so the spec builds the
 * real one over a database double that answers with the ids this caller may read.
 */
function makeDocumentAccess(grants: Map<string, DataScope>, visibleIds: readonly number[]) {
  const builder = {
    from: jest.fn(() => builder),
    where: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(visibleIds.map((id) => ({ id })))),
  };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(grants),
    holds: jest.fn(async (_user: CurrentUserContext, key: string) => (grants.get(key) ?? "none") !== "none"),
  };
  return new DocumentAccessService({ select: jest.fn(() => builder) } as never, access as never);
}

function build(view: DataScope, visibleIds: readonly number[] = []) {
  const links = {
    getState: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    publish: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    updateLink: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    unpublish: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
  };
  const backfill = { run: jest.fn().mockResolvedValue({ dryRun: true, applied: 0 }) };
  const documentAccess = makeDocumentAccess(new Map<string, DataScope>([["hr:documents:view", view]]), visibleIds);
  return { controller: new DocumentKbLinkController(links as never, backfill as never, documentAccess), links, backfill };
}

describe("document knowledge-base link controller", () => {
  describe.each<DataScope>(["own", "team", "none"])("a caller whose document scope is %s", (scope) => {
    it("cannot read where a document stands in the knowledge base, and the service is not reached", async () => {
      const { controller, links } = build(scope);

      await expect(controller.state(DOCUMENT_ID, makeUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(links.getState).not.toHaveBeenCalled();
    });
  });

  /**
   * V-146: whether an HR document is in the knowledge base is a fact about the document. A caller who cannot see
   * the document must not learn its id exists from the shape of the refusal.
   */
  describe("another employee's document", () => {
    const SOMEONE_ELSES = 99;

    it("answers 404, not 403, and the message names neither the document nor the missing authority", async () => {
      const { controller, links } = build("own", [DOCUMENT_ID]);

      const error = await controller.state(SOMEONE_ELSES, makeUser()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as Error).message).toBe("Document not found.");
      expect((error as Error).message).not.toMatch(/99|permission|scope|forbidden|knowledge|publish/i);
      expect(links.getState).not.toHaveBeenCalled();
    });

    it("keeps 403 for the caller who CAN see the document but holds no organisation-wide access", async () => {
      const { controller, links } = build("own", [DOCUMENT_ID]);

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
    await controller.unpublish(DOCUMENT_ID, { reason: "Superseded" }, makeUser());

    expect(links.publish).toHaveBeenCalledWith(actor, DOCUMENT_ID, { audiences: [{ kind: "ALL_EMPLOYEES" }] });
    expect(links.updateLink).toHaveBeenCalledWith(actor, DOCUMENT_ID, { versionMode: "FOLLOW_LATEST" });
    expect(links.unpublish).toHaveBeenCalledWith(actor, DOCUMENT_ID, { reason: "Superseded" });
  });

  it("runs a backfill as the caller from the session, with the organisation from the session and nothing the body could name", async () => {
    const { controller, backfill } = build("none");

    await controller.runBackfill({ dryRun: true, cursor: 0, limit: 100 }, makeUser());

    expect(backfill.run).toHaveBeenCalledWith({ userId: "user-hr", orgId: ORG_ID, membershipId: 41 }, { dryRun: true, cursor: 0, limit: 100 });
  });
});
