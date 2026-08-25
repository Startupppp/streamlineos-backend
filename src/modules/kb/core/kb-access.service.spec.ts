import { KbAccessService } from "./kb-access.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    permissions: [],
    enabledModules: ["kb"],
    ...over,
  } as unknown as CurrentUserContext;
}

describe("KbAccessService.isAdmin", () => {
  function makeService(holdsResult: boolean): KbAccessService {
    const db = {} as never;
    const cache = {} as CacheService;
    const access = { holds: jest.fn().mockResolvedValue(holdsResult) } as unknown as AccessService;
    return new KbAccessService(db, cache, access);
  }

  it("returns true when the seam grants kb:spaces:manage", async () => {
    expect(await makeService(true).isAdmin(makeUser({}))).toBe(true);
  });

  it("returns false when the seam denies kb:spaces:manage", async () => {
    expect(await makeService(false).isAdmin(makeUser({}))).toBe(false);
  });

  it("is true for an org owner who holds nothing explicitly — seam is sole authority", async () => {
    expect(
      await makeService(true).isAdmin(makeUser({ isOrgOwner: true, permissions: [] })),
    ).toBe(true);
  });
});
