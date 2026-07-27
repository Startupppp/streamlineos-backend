import { TenantContextService, getAmbientTenantContext } from "./tenant-context";
import type { TenantContext } from "../../db/rls-context";

const svc = new TenantContextService();

const CTX_A: TenantContext = { orgId: "org-aaaaaaaa-0001", audience: "INTERNAL" };
const CTX_B: TenantContext = {
  orgId: "org-bbbbbbbb-0002",
  audience: "PORTAL",
  membershipId: "mem-0002",
};

describe("TenantContextService (AsyncLocalStorage)", () => {
  it("returns undefined when no run is active", () => {
    expect(svc.current()).toBeUndefined();
    expect(getAmbientTenantContext()).toBeUndefined();
  });

  it("exposes the correct context inside run", async () => {
    let captured: TenantContext | undefined;
    await svc.run(CTX_A, async () => {
      captured = svc.current();
    });
    expect(captured).toStrictEqual(CTX_A);
  });

  it("clears context after run resolves", async () => {
    await svc.run(CTX_A, async () => {});
    expect(svc.current()).toBeUndefined();
  });

  it("getAmbientTenantContext reflects the same store", async () => {
    let captured: TenantContext | undefined;
    await svc.run(CTX_A, async () => {
      captured = getAmbientTenantContext();
    });
    expect(captured).toStrictEqual(CTX_A);
  });

  it("isolates context between two concurrent async flows", async () => {
    const [r1, r2] = await Promise.all([
      svc.run(CTX_A, async () => {
        await new Promise<void>((res) => setTimeout(res, 10));
        return svc.current();
      }),
      svc.run(CTX_B, async () => {
        await new Promise<void>((res) => setTimeout(res, 5));
        return svc.current();
      }),
    ]);
    expect(r1).toStrictEqual(CTX_A);
    expect(r2).toStrictEqual(CTX_B);
  });

  it("nested run shadows the outer context and restores it on exit", async () => {
    let outerDuring: TenantContext | undefined;
    let innerDuring: TenantContext | undefined;
    let outerAfterNested: TenantContext | undefined;

    await svc.run(CTX_A, async () => {
      outerDuring = svc.current();
      await svc.run(CTX_B, async () => {
        innerDuring = svc.current();
      });
      outerAfterNested = svc.current();
    });

    expect(outerDuring).toStrictEqual(CTX_A);
    expect(innerDuring).toStrictEqual(CTX_B);
    expect(outerAfterNested).toStrictEqual(CTX_A);
  });
});
