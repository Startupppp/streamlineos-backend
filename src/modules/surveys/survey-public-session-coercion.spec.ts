import { z } from "zod";

const oldSchema = z
  .object({ collectorToken: z.string().min(1), sessionId: z.string().min(1) })
  .strict();

const newSchema = z
  .object({ collectorToken: z.string().min(1), sessionId: z.coerce.number().int().positive() })
  .strict();

describe("D6 — survey-public sessionId coercion", () => {
  describe("old schema: z.string().min(1) — root-cause reproduction", () => {
    it("passes a non-numeric sessionId through the schema", () => {
      const result = oldSchema.safeParse({ collectorToken: "tok", sessionId: "abc" });
      expect(result.success).toBe(true);
    });

    it("parsed sessionId produces NaN when cast with Number()", () => {
      const result = oldSchema.safeParse({ collectorToken: "tok", sessionId: "abc" });
      expect(result.success).toBe(true);
      if (result.success) expect(Number(result.data.sessionId)).toBeNaN();
    });
  });

  describe("new schema: z.coerce.number().int().positive() — fix verification", () => {
    it("rejects a non-numeric sessionId", () => {
      const result = newSchema.safeParse({ collectorToken: "tok", sessionId: "abc" });
      expect(result.success).toBe(false);
    });

    it("rejects zero", () => {
      const result = newSchema.safeParse({ collectorToken: "tok", sessionId: "0" });
      expect(result.success).toBe(false);
    });

    it("rejects a negative integer", () => {
      const result = newSchema.safeParse({ collectorToken: "tok", sessionId: "-5" });
      expect(result.success).toBe(false);
    });

    it("accepts a valid positive integer string and coerces it to a number", () => {
      const result = newSchema.safeParse({ collectorToken: "tok", sessionId: "42" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.sessionId).toBe(42);
    });

    it("accepts a numeric number directly", () => {
      const result = newSchema.safeParse({ collectorToken: "tok", sessionId: 99 });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.sessionId).toBe(99);
    });
  });
});
