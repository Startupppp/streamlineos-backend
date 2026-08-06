import { JournalPostingService } from "./journal-posting.service";

describe("JournalPostingService", () => {
  describe("seedChartOfAccountsForOrg", () => {
    it("inserts the default chart in one bulk statement", async () => {
      const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
      const values = jest.fn((_rows: Array<Record<string, unknown>>) => ({ onConflictDoNothing }));
      const limit = jest.fn().mockResolvedValue([]);
      const db = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({ limit })),
          })),
        })),
        insert: jest.fn(() => ({ values })),
      };
      const service = new JournalPostingService(db as never);

      await service.seedChartOfAccountsForOrg("org-1");

      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(values).toHaveBeenCalledTimes(1);
      const inserted = values.mock.calls[0][0];
      expect(inserted.length).toBeGreaterThan(40);
      expect(inserted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orgId: "org-1",
            code: "1000",
            name: "Cash",
            accountType: "ASSET",
          }),
        ]),
      );
      expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    });

    it("does not insert when the organization already has a chart", async () => {
      const db = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              limit: jest.fn().mockResolvedValue([{ code: "1000" }]),
            })),
          })),
        })),
        insert: jest.fn(),
      };
      const service = new JournalPostingService(db as never);

      await service.seedChartOfAccountsForOrg("org-1");

      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
