import { NotFoundException } from "@nestjs/common";
import { KbLinkedDocumentsController } from "./kb-linked-documents.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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

function build(enabled: boolean, holdsPublish: boolean) {
  const flags = { assertEnabled: jest.fn().mockImplementation(async () => { if (!enabled) throw new NotFoundException(); }) };
  const query = {
    list: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 30, hasMore: false, nextCursor: null } }),
    get: jest.fn().mockResolvedValue({ id: 5 }),
  };
  const files = { open: jest.fn().mockResolvedValue({ url: "u", fileName: "f", expiresIn: 300 }) };
  const access = { holds: jest.fn().mockResolvedValue(holdsPublish) };
  const controller = new KbLinkedDocumentsController(flags as never, query as never, files as never, access as never);
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
});
