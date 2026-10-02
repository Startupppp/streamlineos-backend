import type { Db } from "../../../db/drizzle.types";

export type Rows = readonly object[];

interface Chain {
  from(): Chain;
  innerJoin(): Chain;
  leftJoin(): Chain;
  where(): Chain;
  orderBy(): Chain;
  limit(): Promise<Rows>;
  for(): Promise<Rows>;
}

export function queuedSelectDb(opts: { inOrg?: object; selects?: Rows[]; lockedRows?: Rows } = {}) {
  const queue = [...(opts.selects ?? [])];
  const select = jest.fn(() => {
    const rows = queue.shift() ?? [];
    const chain: Chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      for: () => Promise.resolve(opts.lockedRows ?? []),
    };
    return chain;
  });
  const findFirst = jest.fn().mockResolvedValue(opts.inOrg);
  const execute = jest.fn().mockResolvedValue(undefined);
  const fake = { select, execute, query: { projects: { findFirst } } };
  return { db: fake as unknown as Db, select, findFirst };
}
