import type { Db } from "../../db/drizzle.module";
import { CareersService } from "./careers.service";

function makeDb(): { db: Db } {
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve([]).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve([]).catch(fn),
    finally: (fn: () => void) => Promise.resolve([]).finally(fn),
  };
  for (const m of ["where", "orderBy", "limit", "offset", "leftJoin", "innerJoin"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  const from = jest.fn().mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db };
}

describe("CareersService — cross-tenant isolation", () => {
  it("listOpenJobs: filters by status only (no cross-tenant boundary — public endpoint)", async () => {
    const { db } = makeDb();
    const cache = {
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new CareersService(db, cache as never, {} as never);
    const result = await svc.listOpenJobs();
    expect(result).toHaveLength(0);
  });

  it("CareersService.apply: returns job_not_found when posting does not exist — no org can be forged (isolation)", async () => {
    const { db } = makeDb();
    const cache = {
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new CareersService(db, cache as never, {} as never);
    const result = await svc.apply({
      jobPostingId: 9999,
      name: "Attacker",
      email: "attacker@evil.com",
      phone: undefined,
      linkedinUrl: undefined,
      coverLetter: undefined,
      resumeUrl: undefined,
      answers: {},
    });
    expect(result).toEqual({ error: "job_not_found" });
  });
});
