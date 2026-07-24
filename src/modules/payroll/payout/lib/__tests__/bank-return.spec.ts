import { parseBankReturnCsv } from "../bank-return";

describe("parseBankReturnCsv", () => {
  it("parses PAID and FAILED rows by itemId", () => {
    const csv = [
      "itemId,status,transactionRef,failureReason",
      "10,PAID,UTR001,",
      "11,FAILED,,NSF",
      "12,RETURNED,,account closed",
    ].join("\n");
    const result = parseBankReturnCsv(csv);
    expect(result.mode).toBe("export_manual");
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toMatchObject({
      itemId: 10,
      status: "PAID",
      transactionRef: "UTR001",
    });
    expect(result.lines[1]).toMatchObject({ itemId: 11, status: "FAILED", failureReason: "NSF" });
    expect(result.lines[2]?.status).toBe("FAILED");
  });

  it("matches by userId when itemId absent", () => {
    const csv = "userId,status,utr\nu-abc,SUCCESS,REF9\n";
    const result = parseBankReturnCsv(csv);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      userId: "u-abc",
      status: "PAID",
      transactionRef: "REF9",
    });
  });

  it("reports errors for missing status and unpaid without ref", () => {
    expect(parseBankReturnCsv("itemId,foo\n1,x\n").errors[0]?.message).toMatch(/status/i);
    const bad = parseBankReturnCsv("itemId,status\n5,PAID\n");
    expect(bad.errors.some((e) => /transactionRef/i.test(e.message))).toBe(true);
  });
});
