import { NotFoundException } from "@nestjs/common";
import { KbLinkedDocumentsController } from "./kb-linked-documents.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { DocumentAccessService } from "../../hr/performance/document-access.service";

const ORG_ID = "org-kb-read-controller";

const makeUser = (): CurrentUserContext => ({
  userId: "user-reader",
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess",
  tokenScopes: null,
  principal: humanSessionPrincipal(61, false),
});

/** The controller reads publish authority from the one document principal, so the spec builds the real service. */
function makeDocumentAccess(holdsPublish: boolean) {
  const grants = new Map<string, DataScope>([["hr:documents:publish", holdsPublish ? "all" : "none"]]);
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(grants),
    holds: jest.fn(async (_user: CurrentUserContext, key: string) => (grants.get(key) ?? "none") !== "none"),
  };
  return { documentAccess: new DocumentAccessService({ select: jest.fn() } as never, access as never), access };
}

function build(enabled: boolean, holdsPublish: boolean) {
  const flags = { assertEnabled: jest.fn().mockImplementation(async () => { if (!enabled) throw new NotFoundException(); }) };
  const query = {
    list: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 30, hasMore: false, nextCursor: null } }),
    get: jest.fn().mockResolvedValue({ id: 5 }),
  };
  const files = { open: jest.fn().mockResolvedValue({ url: "u", fileName: "f", expiresIn: 300 }) };
  const { documentAccess, access } = makeDocumentAccess(holdsPublish);
  const controller = new KbLinkedDocumentsController(flags as never, query as never, files as never, documentAccess);
  return { controller, flags, query, files, access };
}

describe("KB linked documents controller", () => {
  it("answers 404 for every route while the switch is off, before any query or signing", async () => {
    const { controller, query, files } = build(false, true);

    await expect(controller.list({ limit: 30 }, makeUser())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.get(5, makeUser())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.open(5, makeUser())).rejects.toBeInstanceOf(NotFoundException);

    expect(query.list).not.toHaveBeenCalled();
    expect(query.get).not.toHaveBeenCalled();
    expect(files.open).not.toHaveBeenCalled();
  });

  it("asks the switch about the caller's own tenant, and works out publish authority from their grants", async () => {
    const { controller, flags, query, access } = build(true, true);

    await controller.list({ limit: 30 }, makeUser());

    expect(flags.assertEnabled).toHaveBeenCalledWith(ORG_ID, "link");
    expect(access.holds).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-reader" }), "hr:documents:publish");
    expect(query.list).toHaveBeenCalledWith({ orgId: ORG_ID, userId: "user-reader", canPublish: true }, { limit: 30 });
  });

  it("treats a caller without the publish permission as an ordinary reader on every route", async () => {
    const { controller, query, files } = build(true, false);

    await controller.get(5, makeUser());
    await controller.open(5, makeUser());

    const reader = { orgId: ORG_ID, userId: "user-reader", canPublish: false };
    expect(query.get).toHaveBeenCalledWith(reader, 5);
    expect(files.open).toHaveBeenCalledWith(reader, 5);
  });

  it("needs the search switch, not just the link switch, to search, and browses on the link switch alone", async () => {
    const { controller, flags, query } = build(true, false);

    await controller.list({ limit: 30 }, makeUser());
    expect(flags.assertEnabled).toHaveBeenLastCalledWith(ORG_ID, "link");

    await controller.list({ limit: 30, q: "leave" }, makeUser());
    expect(flags.assertEnabled).toHaveBeenLastCalledWith(ORG_ID, "search");
    expect(query.list).toHaveBeenLastCalledWith({ orgId: ORG_ID, userId: "user-reader", canPublish: false }, { limit: 30, q: "leave" });
  });

  it("answers 404 to a search while the search switch is off, before any query runs", async () => {
    const flags = { assertEnabled: jest.fn().mockImplementation(async (_org: string, flag: string) => { if (flag === "search") throw new NotFoundException(); }) };
    const query = { list: jest.fn(), get: jest.fn() };
    const controller = new KbLinkedDocumentsController(flags as never, query as never, {} as never, makeDocumentAccess(false).documentAccess);

    await expect(controller.list({ limit: 30, q: "leave" }, makeUser())).rejects.toBeInstanceOf(NotFoundException);
    expect(query.list).not.toHaveBeenCalled();
  });
});
