import { restoreTicketRows } from "./apply-ticket-change";

function buildTx(rows: Array<{ id: number }>) {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { tx: { update }, update, set, where, returning };
}

describe("restoreTicketRows", () => {
  it("restores the matching rows through the canonical ticket mutation module", async () => {
    const { tx, update, set, where, returning } = buildTx([
      { id: 11 },
      { id: 12 },
    ]);

    await expect(
      restoreTicketRows(tx as never, {
        orgId: "org-1",
        projectId: 5,
        deletedAt: new Date("2026-03-01T10:00:00.000Z"),
        ticketIds: [11, 12],
      }),
    ).resolves.toEqual([{ id: 11 }, { id: 12 }]);

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ deletedAt: null });
    expect(where).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);
  });

  it("does not issue an unscoped update for an explicitly empty ticket selection", async () => {
    const { tx, update } = buildTx([]);

    await expect(
      restoreTicketRows(tx as never, {
        orgId: "org-1",
        projectId: 5,
        deletedAt: new Date("2026-03-01T10:00:00.000Z"),
        ticketIds: [],
      }),
    ).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
  });
});
