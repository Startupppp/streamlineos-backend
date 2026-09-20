import type { Db } from "../../../db/drizzle.module";
import { MarketplaceService } from "./marketplace.service";

function makeLimitCapture() {
  const captured: number[] = [];
  const limitFn = jest.fn().mockImplementation((n: number) => {
    captured.push(n);
    return Promise.resolve([]);
  });
  return { captured, limitFn };
}

describe("MarketplaceService — single-row reads carry limit(1) to prevent full table materialisation", () => {
  it("installApp app existence check issues limit(1) so the driver does not materialise the whole marketplace_apps table", async () => {
    const { captured, limitFn } = makeLimitCapture();
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({ limit: limitFn }),
        orderBy: jest.fn().mockReturnValue({ limit: limitFn }),
      }),
    } as unknown as Db;
    const svc = new MarketplaceService(db);
    await svc.installApp("org1", "user1", 42).catch(() => {});
    expect(captured).toContain(1);
  });

  it("uninstallApp existence check issues limit(1) so the driver does not materialise the whole app_installations table", async () => {
    const { captured, limitFn } = makeLimitCapture();
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({ limit: limitFn }),
      }),
    } as unknown as Db;
    const svc = new MarketplaceService(db);
    await svc.uninstallApp("org1", 42).catch(() => {});
    expect(captured).toContain(1);
  });

  it("startAppTrial app existence check issues limit(1) so the driver does not materialise the whole marketplace_apps table", async () => {
    const { captured, limitFn } = makeLimitCapture();
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({ limit: limitFn }),
      }),
    } as unknown as Db;
    const svc = new MarketplaceService(db);
    await svc.startAppTrial("org1", "user1", 42).catch(() => {});
    expect(captured).toContain(1);
  });
});
