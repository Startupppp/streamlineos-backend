import type { Request } from "express";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListEnvelopesInput } from "../dto/e-sign.schemas";
import { SignEnvelopesController } from "../sign-envelopes.controller";
import type { SignEnvelopesService } from "../sign-envelopes.service";

const ORG = "org-scope-test";
const MEMBER_ID = 5;

const makeService = (): jest.Mocked<Pick<SignEnvelopesService, "list">> => ({
  list: jest.fn().mockResolvedValue({ data: [], pageInfo: { hasMore: false } }),
});

const makeUser = (): CurrentUserContext =>
  ({
    orgId: ORG,
    userId: "user-scope-1",
    isOrgOwner: false,
    permissions: [],
    principal: { kind: "human-session", membershipId: MEMBER_ID, isOrgOwner: false },
  }) as unknown as CurrentUserContext;

const makeQuery = (): ListEnvelopesInput =>
  ({ page: 1, limit: 25 }) as unknown as ListEnvelopesInput;

describe("SignEnvelopesController list — DataScope → viewAll", () => {
  it("passes viewAll:true when req.rbacScope is 'all'", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "all" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    expect(svc.list).toHaveBeenCalledWith(ORG, expect.anything(), expect.objectContaining({ viewAll: true }));
  });

  it("passes viewAll:false when req.rbacScope is 'own'", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "own" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    expect(svc.list).toHaveBeenCalledWith(ORG, expect.anything(), expect.objectContaining({ viewAll: false }));
  });

  it("passes viewAll:false when req.rbacScope is 'team'", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "team" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    expect(svc.list).toHaveBeenCalledWith(ORG, expect.anything(), expect.objectContaining({ viewAll: false }));
  });

  it("passes viewAll:false when req.rbacScope is absent (guard not run)", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = {} as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    expect(svc.list).toHaveBeenCalledWith(ORG, expect.anything(), expect.objectContaining({ viewAll: false }));
  });

  it("always passes membershipId from the authenticated context", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "all" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    expect(svc.list).toHaveBeenCalledWith(ORG, expect.anything(), expect.objectContaining({ membershipId: MEMBER_ID }));
  });
});
