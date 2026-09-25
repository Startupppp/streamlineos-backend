import { NotFoundException } from "@nestjs/common";
import { DocumentClassificationController } from "./document-classification.controller";
import { DocumentAccessService } from "./document-access.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

const ORG_ID = "org-classify-controller";
const DOCUMENT_ID = 11;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-hr",
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess",
    tokenScopes: null,
    principal: humanSessionPrincipal(31, false),
    ...overrides,
  };
}

/**
 * Classification is organisation-wide authority. A holder of `hr:documents:view` or `:manage` below scope `all`
 * must not read how the company's documents are classified or change it, and the publish permission is read
 * from the caller's grants, never from the request. The service is a mock: what is pinned is that it is not
 * reached, and what it is handed when it is.
 */

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

function build(view: DataScope, manage: DataScope, publish: DataScope, visibleIds: readonly number[] = []) {
  const service = {
    get: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    classify: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
    setAudiences: jest.fn().mockResolvedValue({ documentId: DOCUMENT_ID }),
  };
  const grants = new Map<string, DataScope>([
    ["hr:documents:view", view],
    ["hr:documents:manage", manage],
    ["hr:documents:publish", publish],
  ]);
  const documentAccess = makeDocumentAccess(grants, visibleIds);
  return { controller: new DocumentClassificationController(service as never, documentAccess), service };
}

describe("document classification controller", () => {
  describe.each<DataScope>(["own", "team", "none"])("a caller whose document scope is %s", (scope) => {
    it("cannot read a document's classification, and the service is not reached", async () => {
      const { controller, service } = build(scope, "all", "all");

      await expect(controller.get(DOCUMENT_ID, makeUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(service.get).not.toHaveBeenCalled();
    });

    it("cannot classify a document, and the service is not reached", async () => {
      const { controller, service } = build("all", scope, "all");

      await expect(controller.classify(DOCUMENT_ID, { classification: "INTERNAL" }, makeUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(service.classify).not.toHaveBeenCalled();
    });
  });

  it("reads for a caller with organisation-wide view, handing the service only the tenant from the session", async () => {
    const { controller, service } = build("all", "none", "none");

    await controller.get(DOCUMENT_ID, makeUser());

    expect(service.get).toHaveBeenCalledWith(ORG_ID, DOCUMENT_ID);
  });

  it("tells the service whether the caller holds the publish permission, and who is acting", async () => {
    const withPublish = build("all", "all", "all");
    const withoutPublish = build("all", "all", "none");

    await withPublish.controller.classify(DOCUMENT_ID, { classification: "INTERNAL" }, makeUser());
    await withoutPublish.controller.classify(DOCUMENT_ID, { classification: "INTERNAL" }, makeUser());

    expect(withPublish.service.classify).toHaveBeenCalledWith(
      { userId: "user-hr", orgId: ORG_ID, membershipId: 31 },
      DOCUMENT_ID,
      { classification: "INTERNAL" },
      true,
    );
    expect(withoutPublish.service.classify.mock.calls[0]?.[3]).toBe(false);
  });

  it("lets the organisation owner classify without holding any grant", async () => {
    const { controller, service } = build("none", "none", "none");

    await controller.classify(DOCUMENT_ID, { classification: "RESTRICTED" }, makeUser({ isOrgOwner: true }));

    expect(service.classify).toHaveBeenCalledTimes(1);
  });

  it("sets audiences through the service, taking identity from the session and never from the body", async () => {
    const { controller, service } = build("none", "none", "all");

    await controller.setAudiences(DOCUMENT_ID, { audiences: [{ kind: "ALL_EMPLOYEES" }] }, makeUser());

    expect(service.setAudiences).toHaveBeenCalledWith(
      { userId: "user-hr", orgId: ORG_ID, membershipId: 31 },
      DOCUMENT_ID,
      { audiences: [{ kind: "ALL_EMPLOYEES" }] },
    );
  });
});
