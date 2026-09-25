import type { Db } from "../../../db/drizzle.module";
import { orgBusinessDate } from "./attendance-business-date";

function dbReturning(rows: Array<{ timezone: string | null }>): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain as unknown as Db;
}

describe("orgBusinessDate", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // 20:00 UTC on the 25th is already the 26th in India.
    jest.setSystemTime(new Date("2026-09-25T20:00:00Z"));
  });
  afterEach(() => jest.useRealTimers());

  it("returns the org's local date, the one check-in stamps, not the server's", async () => {
    await expect(orgBusinessDate(dbReturning([{ timezone: "Asia/Kolkata" }]), "org")).resolves.toBe("2026-09-26");
    await expect(orgBusinessDate(dbReturning([{ timezone: "America/New_York" }]), "org")).resolves.toBe("2026-09-25");
  });

  it("falls back to the server date when the org has no usable timezone", async () => {
    await expect(orgBusinessDate(dbReturning([{ timezone: null }]), "org")).resolves.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(orgBusinessDate(dbReturning([{ timezone: "Not/AZone" }]), "org")).resolves.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
