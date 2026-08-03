import { NumberSequenceService } from "../number-sequence.service";

describe("NumberSequenceService", () => {
  function buildMockDb(returningRow: { prefix: string; nextNumber: number; padding: number } | null) {
    const returning = jest.fn().mockResolvedValue(returningRow ? [returningRow] : []);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    return { insert, update, _returning: returning };
  }

  describe("next — sequence formatting", () => {
    it("formats first sequence number with 5-digit padding", async () => {
      const db = buildMockDb({ prefix: "PO", nextNumber: 2, padding: 5 });
      const service = new NumberSequenceService(db as never);
      const result = await service.next("org1", "PO");
      expect(result).toBe("PO-00001");
    });

    it("formats double-digit sequence number", async () => {
      const db = buildMockDb({ prefix: "GRN", nextNumber: 11, padding: 5 });
      const service = new NumberSequenceService(db as never);
      const result = await service.next("org1", "GRN");
      expect(result).toBe("GRN-00010");
    });

    it("maps TRANSFER docType to TRF prefix", async () => {
      const db = buildMockDb({ prefix: "TRF", nextNumber: 3, padding: 5 });
      const service = new NumberSequenceService(db as never);
      const result = await service.next("org1", "TRANSFER");
      expect(result).toBe("TRF-00002");
    });

    it("maps ADJUSTMENT docType to ADJ prefix", async () => {
      const db = buildMockDb({ prefix: "ADJ", nextNumber: 6, padding: 5 });
      const service = new NumberSequenceService(db as never);
      const result = await service.next("org1", "ADJUSTMENT");
      expect(result).toBe("ADJ-00005");
    });

    it("falls back to docType itself as prefix for unknown types", async () => {
      const db = buildMockDb({ prefix: "CUSTOM", nextNumber: 2, padding: 5 });
      const service = new NumberSequenceService(db as never);
      const result = await service.next("org1", "CUSTOM");
      expect(result).toBe("CUSTOM-00001");
    });

    it("throws when row is not returned from update", async () => {
      const db = buildMockDb(null);
      const service = new NumberSequenceService(db as never);
      await expect(service.next("org1", "PO")).rejects.toThrow("Number sequence not found");
    });
  });

  describe("getDocTypes", () => {
    it("returns all known doc type keys", () => {
      const db = buildMockDb({ prefix: "PO", nextNumber: 1, padding: 5 });
      const service = new NumberSequenceService(db as never);
      const types = service.getDocTypes();
      expect(types).toContain("PO");
      expect(types).toContain("GRN");
      expect(types).toContain("SO");
      expect(types).toContain("SHIPMENT");
      expect(types).toContain("INSPECTION");
      expect(types).toContain("RECALL");
      expect(types).toContain("VENDOR_RETURN");
      expect(types).toContain("CUSTOMER_RETURN");
      expect(types.length).toBeGreaterThanOrEqual(15);
    });
  });
});
