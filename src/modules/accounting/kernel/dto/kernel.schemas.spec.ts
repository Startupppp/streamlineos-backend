import { DB_ENUMS } from "../../../../db/enums.generated";
import { systemTagSchema, journalSourceSchema } from "./kernel.schemas";

describe("kernel.schemas — enum drift guard", () => {
  describe("journalSourceSchema vs gl_journal_source pgEnum", () => {
    it("accepts the expense_claim journal source that the hand-written list omitted", () => {
      expect(journalSourceSchema.parse("expense_claim")).toBe("expense_claim");
    });

    it("journalSourceSchema member set equals DB_ENUMS.gl_journal_source exactly so a future pgEnum change cannot drift again", () => {
      expect([...journalSourceSchema.options]).toEqual([...DB_ENUMS.gl_journal_source]);
    });
  });

  describe("systemTagSchema vs gl_system_tag pgEnum", () => {
    it("accepts the grni, inventory_write_off, inventory_adjustment and landed_cost system tags the hand-written list omitted", () => {
      for (const tag of ["grni", "inventory_write_off", "inventory_adjustment", "landed_cost"]) {
        expect(systemTagSchema.parse(tag)).toBe(tag);
      }
    });

    it("systemTagSchema member set equals DB_ENUMS.gl_system_tag exactly so a future pgEnum change cannot drift again", () => {
      expect([...systemTagSchema.options]).toEqual([...DB_ENUMS.gl_system_tag]);
    });
  });
});
