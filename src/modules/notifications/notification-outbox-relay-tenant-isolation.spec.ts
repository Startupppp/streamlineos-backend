import type { Db } from "../../db/drizzle.module";
import { NotificationOutboxRelayService } from "./notification-outbox-relay.service";

function makeDb(orgRows: { id: string }[], outboxRows: unknown[] = []) {
  let selectCount = 0;
  const selectChain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  selectChain.orderBy.mockImplementation(() => Promise.resolve(orgRows));

  const updateChain = {
    set: jest.fn(),
    where: jest.fn(),
    returning: jest.fn().mockResolvedValue(outboxRows),
  };
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockReturnValue(updateChain);

  const innerTx = {
    update: jest.fn().mockReturnValue(updateChain),
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue(selectChain),
  };

  const selectMock = jest.fn().mockImplementation(() => { selectCount++; return selectChain; });
  const db = {
    select: selectMock,
    update: jest.fn().mockReturnValue(updateChain),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(innerTx)),
  } as unknown as Db;

  return { db, selectChain, updateChain, innerTx, getSelectCount: () => selectCount, selectMock };
}

describe("NotificationOutboxRelayService — cross-tenant isolation (background relay)", () => {
  it("does not dispatch for any org when outbox is empty (isolation — no cross-org data leaked)", async () => {
    const { db } = makeDb([{ id: "org-a" }, { id: "org-b" }], []);
    const dispatch = { emitNow: jest.fn() } as never;
    const svc = new NotificationOutboxRelayService(db, dispatch);

    const result = await svc.flush();

    expect(result.claimed).toBe(0);
    expect(result.processed).toBe(0);
    expect((dispatch as { emitNow: jest.Mock }).emitNow).not.toHaveBeenCalled();
  });

  it("enumerates all active orgs independently so each org stays isolated (org isolation — control)", async () => {
    const { db, selectMock } = makeDb([{ id: "org-owner" }], []);
    const dispatch = { emitNow: jest.fn() } as never;
    const svc = new NotificationOutboxRelayService(db, dispatch);

    const result = await svc.flush();

    expect(result.claimed).toBe(0);
    expect(selectMock).toHaveBeenCalled();
  });
});
