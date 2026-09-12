import { BadRequestException } from "@nestjs/common";
import {
  assertReceiptLine,
  resolveDispensingSafety,
  resolveReceiptRequirements,
  type PharmacyClassification,
} from "../lib/pharmacy";

/**
 * E3 — the two pharmacy rules, exhaustively, with no database.
 *
 * The distinction being pinned is *where* each one bites: nothing about
 * dispensing refuses, and the receipt refuses only for information that stops
 * existing once the carton is opened.
 */

const plain: PharmacyClassification = {
  mrpPaise: null,
  mrpRequired: false,
  drugSchedule: null,
  isHighAlert: false,
  lasaGroup: null,
  trackingMethod: "NONE",
};

const codes = (c: PharmacyClassification, confusable: Array<{ productId: number; sku: string; name: string }> = []) =>
  resolveDispensingSafety(c, confusable).alerts.map((a) => `${a.code}:${a.disposition}`);

describe("E3 dispensing safety", () => {
  it("says nothing about an unclassified product", () => {
    expect(codes(plain)).toEqual([]);
    expect(resolveDispensingSafety(plain, []).acknowledgementRequired).toBe(false);
  });

  it("never blocks a dispense, whatever is flagged", () => {
    const everything: PharmacyClassification = {
      ...plain,
      isHighAlert: true,
      lasaGroup: "amox",
      drugSchedule: "NARCOTIC",
    };
    // The whole design decision, asserted: a LASA or high-alert block is a block
    // that gets switched off inside a week, and then nothing warns at all.
    expect(resolveDispensingSafety(everything, []).blocksDispense).toBe(false);
  });

  it("asks for a confirmation on LASA only once something else shares the group", () => {
    const lasa: PharmacyClassification = { ...plain, lasaGroup: "amox" };
    expect(codes(lasa)).toEqual(["LASA:WARN"]);
    expect(codes(lasa, [{ productId: 2, sku: "AMOXIL", name: "Amoxil" }])).toEqual(["LASA:ACKNOWLEDGE"]);
  });

  it("names the confusable products in the message, because that is the warning", () => {
    const [alert] = resolveDispensingSafety({ ...plain, lasaGroup: "amox" }, [
      { productId: 2, sku: "AMOXIL-250", name: "Amoxil" },
      { productId: 3, sku: "AMOXIL-500", name: "Amoxil Forte" },
    ]).alerts;
    expect(alert!.message).toContain("Amoxil (AMOXIL-250)");
    expect(alert!.message).toContain("Amoxil Forte (AMOXIL-500)");
  });

  it("grades the schedules: H warns, H1 and above ask for a confirmation and a register entry", () => {
    expect(codes({ ...plain, drugSchedule: "OTC" })).toEqual([]);
    expect(codes({ ...plain, drugSchedule: "H" })).toEqual(["PRESCRIPTION_REQUIRED:WARN"]);
    expect(codes({ ...plain, drugSchedule: "H1" })).toEqual([
      "PRESCRIPTION_REQUIRED:ACKNOWLEDGE",
      "REGISTER_ENTRY_REQUIRED:ACKNOWLEDGE",
    ]);
    expect(codes({ ...plain, drugSchedule: "X" })).toEqual([
      "PRESCRIPTION_REQUIRED:ACKNOWLEDGE",
      "REGISTER_ENTRY_REQUIRED:ACKNOWLEDGE",
    ]);
    expect(codes({ ...plain, drugSchedule: "NARCOTIC" })).toEqual([
      "PRESCRIPTION_REQUIRED:ACKNOWLEDGE",
      "REGISTER_ENTRY_REQUIRED:ACKNOWLEDGE",
    ]);
  });

  it("says plainly that the register it names is not one this system keeps", () => {
    const alert = resolveDispensingSafety({ ...plain, drugSchedule: "H1" }, []).alerts.find(
      (a) => a.code === "REGISTER_ENTRY_REQUIRED",
    );
    expect(alert!.message).toContain("does not keep that register");
  });
});

describe("E3 receipt requirements", () => {
  it("requires nothing while the pack is off", () => {
    // `null` is how the service says "pharmacy pack off". Every requirement has
    // to fall away, not merely be hidden.
    expect(resolveReceiptRequirements(null)).toEqual({
      mrpRequired: false,
      lotRequired: false,
      expiryRequired: false,
      suggestedMrpPaise: null,
    });
  });

  it("offers the catalogue MRP as a default without requiring it", () => {
    expect(resolveReceiptRequirements({ ...plain, mrpPaise: 12550 })).toEqual({
      mrpRequired: false,
      lotRequired: false,
      expiryRequired: false,
      suggestedMrpPaise: 12550,
    });
  });

  it("requires a batch and an expiry for a lot-tracked SKU", () => {
    expect(resolveReceiptRequirements({ ...plain, trackingMethod: "LOT" })).toMatchObject({
      lotRequired: true,
      expiryRequired: true,
    });
  });
});

describe("E3 receipt gate", () => {
  const flagged: PharmacyClassification = { ...plain, mrpRequired: true, trackingMethod: "LOT" };
  const goodLine = { mrpPaise: 12550, lotNumber: "B-1", expiryDate: "2027-03-31" };

  it("accepts a complete line", () => {
    expect(() => assertReceiptLine(flagged, goodLine, "Amoxil (AMX)")).not.toThrow();
  });

  it("refuses a flagged SKU with no MRP", () => {
    expect(() => assertReceiptLine(flagged, { ...goodLine, mrpPaise: null }, "Amoxil (AMX)")).toThrow(
      BadRequestException,
    );
  });

  it("refuses a lot-tracked SKU with no batch and with no expiry", () => {
    expect(() => assertReceiptLine(flagged, { ...goodLine, lotNumber: "  " }, "Amoxil (AMX)")).toThrow(
      BadRequestException,
    );
    expect(() => assertReceiptLine(flagged, { ...goodLine, expiryDate: null }, "Amoxil (AMX)")).toThrow(
      BadRequestException,
    );
  });

  it("refuses a purchase rate above the printed MRP — the transposed pair", () => {
    expect(() =>
      assertReceiptLine(flagged, { ...goodLine, purchaseRatePaise: 13000 }, "Amoxil (AMX)"),
    ).toThrow(BadRequestException);
    // Equal is legitimate; only strictly above is the typo.
    expect(() =>
      assertReceiptLine(flagged, { ...goodLine, purchaseRatePaise: 12550 }, "Amoxil (AMX)"),
    ).not.toThrow();
  });

  it("requires nothing at all while the pack is off, on the same line", () => {
    // The same empty line that was refused above. This is what the flag *does*.
    expect(() => assertReceiptLine(null, { mrpPaise: null, lotNumber: null }, "Amoxil (AMX)")).not.toThrow();
  });

  it("names the product in every refusal, because the operator is holding a pallet", () => {
    try {
      assertReceiptLine(flagged, { ...goodLine, mrpPaise: null }, "Amoxil 250mg (AMX-250)");
      throw new Error("expected a refusal");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { code: string; message: string };
      expect(body.code).toBe("MRP_REQUIRED");
      expect(body.message).toContain("Amoxil 250mg (AMX-250)");
    }
  });
});
