import type { Request } from "express";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListEnvelopesInput } from "../dto/e-sign.schemas";
import { ScopedRead } from "../../access/scoped-read";
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

function forwardedRead(svc: jest.Mocked<Pick<SignEnvelopesService, "list">>): ScopedRead {
  const [read] = svc.list.mock.calls[0] as [ScopedRead, number | null, ListEnvelopesInput];
  return read;
}

describe("SignEnvelopesController list — request scope becomes a ScopedRead", () => {
  it("forwards an unrestricted ScopedRead when req.rbacScope is 'all'", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "all" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    const read = forwardedRead(svc);
    expect(read).toBeInstanceOf(ScopedRead);
    expect(read.denied).toBe(false);
    expect(read.discriminator).toBe("all");
  });

  it("forwards an own-scoped ScopedRead when req.rbacScope is 'own'", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "own" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    const read = forwardedRead(svc);
    expect(read.denied).toBe(false);
    expect(read.discriminator).toBe("own:user-scope-1");
  });

  it("forwards a team-scoped ScopedRead when req.rbacScope is 'team'", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "team" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    const read = forwardedRead(svc);
    expect(read.denied).toBe(false);
    expect(read.discriminator).toBe("team:user-scope-1");
  });

  it("fails closed to a denied ScopedRead when req.rbacScope is absent (guard not run)", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = {} as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    const read = forwardedRead(svc);
    expect(read.denied).toBe(true);
  });

  it("always passes membershipId from the authenticated context", () => {
    const svc = makeService();
    const ctrl = new SignEnvelopesController(svc as unknown as SignEnvelopesService);
    const req = { rbacScope: "all" } as Request;

    ctrl.list(makeQuery(), makeUser(), req);

    const [, membershipId] = svc.list.mock.calls[0] as [ScopedRead, number | null, ListEnvelopesInput];
    expect(membershipId).toBe(MEMBER_ID);
  });
});
