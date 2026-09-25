import { ForbiddenException } from "@nestjs/common";
import { HrTemplatesController } from "./hr-templates.controller";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-hr",
    orgId: "org-renders",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess",
    tokenScopes: null,
    principal: humanSessionPrincipal(20, false),
    ...overrides,
  };
}

function build(documentsView: DataScope) {
  const service = { listRenders: jest.fn().mockResolvedValue({ data: [] }) };
  const access = {
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(new Map<string, DataScope>([["hr:documents:view", documentsView]])),
  };
  return { controller: new HrTemplatesController(service as never, access as never), service };
}

/**
 * Every row of `GET /hr/templates/:id/renders` is a letter rendered for one employee and carries
 * `outputHtml` and `contextSnapshot`. The route was gated on `hr:templates:view` alone, which says
 * nothing about whose letters may be read; it now needs the same organisation-wide document scope as
 * the letters list. No frontend screen calls it, so nothing legitimate depended on the old reach.
 */
describe("GET /hr/templates/:id/renders needs organisation-wide document scope", () => {
  it.each<DataScope>(["own", "team", "none"])(
    "refuses a caller whose document scope is %s and never reaches the service",
    async (scope) => {
      const { controller, service } = build(scope);

      await expect(controller.listRenders(3, { limit: 20 } as never, makeUser())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(service.listRenders).not.toHaveBeenCalled();
    },
  );

  it("serves a caller whose document scope is all", async () => {
    const { controller, service } = build("all");

    await controller.listRenders(3, { limit: 20 } as never, makeUser());

    expect(service.listRenders).toHaveBeenCalledWith("org-renders", 3, { limit: 20 });
  });

  it("serves the organisation owner", async () => {
    const { controller, service } = build("none");

    await controller.listRenders(3, { limit: 20 } as never, makeUser({ isOrgOwner: true }));

    expect(service.listRenders).toHaveBeenCalledTimes(1);
  });
});
