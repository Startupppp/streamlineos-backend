import { NotFoundException } from "@nestjs/common";
import {
  readTicketVersionForSystemWrite,
  type TicketVersionSource,
} from "./tickets-helpers";

type Row = { version: number };

function dbReturning(rows: Row[]): {
  chain: TicketVersionSource;
  calls: { limit: number | null };
} {
  const calls: { limit: number | null } = { limit: null };
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: (n: number) => {
      calls.limit = n;
      return Promise.resolve(rows);
    },
  };
  return { chain, calls };
}

describe("a system actor with no client token reads the current version rather than skipping the compare-and-swap", () => {
  it("returns the row's current version so the caller can supply it to the compare-and-swap", async () => {
    const { chain } = dbReturning([{ version: 7 }]);
    const version = await readTicketVersionForSystemWrite(
      chain,
      "org-1",
      42,
    );
    expect(version).toBe(7);
  });

  it("reads exactly one row, so a system write cannot fan out across a project", async () => {
    const { chain, calls } = dbReturning([{ version: 3 }]);
    await readTicketVersionForSystemWrite(chain, "org-1", 42);
    expect(calls.limit).toBe(1);
  });

  it("throws NotFound rather than returning a default version when the ticket is absent or soft-deleted", async () => {
    const { chain } = dbReturning([]);
    await expect(
      readTicketVersionForSystemWrite(chain, "org-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not coerce a missing row into version zero, which would silently overwrite a live ticket", async () => {
    const { chain } = dbReturning([]);
    const outcome = await readTicketVersionForSystemWrite(
      chain,
      "org-1",
      42,
    ).then(
      (v) => ({ resolved: v }),
      (e: unknown) => ({ rejected: e }),
    );
    expect(outcome).not.toHaveProperty("resolved");
    expect(outcome).toHaveProperty("rejected");
  });
});
