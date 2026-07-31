import { parseCsv, toCsv } from "../../csv.util";
import { ImportService } from "../../import.service";

describe("parseCsv", () => {
  it("parses a simple 2-column, 2-row CSV", () => {
    const text = "name,value\nfoo,bar\nbaz,qux";
    const { headers, rows } = parseCsv(text);

    expect(headers).toEqual(["name", "value"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: "foo", value: "bar" });
    expect(rows[1]).toEqual({ name: "baz", value: "qux" });
  });

  it("handles quoted field containing a comma", () => {
    const text = 'name,address\nAlice,"123 Main St, Apt 4"';
    const { rows } = parseCsv(text);

    expect(rows[0]).toEqual({ name: "Alice", address: "123 Main St, Apt 4" });
  });

  it("handles quoted field containing an escaped double-quote", () => {
    const text = 'name,bio\nBob,"He said ""hello"""';
    const { rows } = parseCsv(text);

    expect(rows[0]).toEqual({ name: "Bob", bio: 'He said "hello"' });
  });

  it("treats empty cells as empty strings", () => {
    const text = "a,b,c\n1,,3";
    const { rows } = parseCsv(text);

    expect(rows[0]).toEqual({ a: "1", b: "", c: "3" });
  });

  it("returns empty headers and rows for empty input", () => {
    const { headers, rows } = parseCsv("");

    expect(headers).toEqual([]);
    expect(rows).toHaveLength(0);
  });

  it("handles CRLF line endings", () => {
    const text = "x,y\r\n1,2\r\n3,4";
    const { rows } = parseCsv(text);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ x: "1", y: "2" });
  });
});

describe("toCsv", () => {
  it("generates correct header row from headers array", () => {
    const csv = toCsv(["sku", "qty"], []);
    const lines = csv.split("\n");

    expect(lines[0]).toBe("sku,qty");
  });

  it("escapes commas in field values", () => {
    const csv = toCsv(["name"], [{ name: "Smith, John" }]);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"Smith, John"');
  });

  it("escapes double-quotes in field values", () => {
    const csv = toCsv(["note"], [{ note: 'say "hi"' }]);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"say ""hi"""');
  });

  it("converts null and undefined values to empty string", () => {
    const csv = toCsv(["a", "b"], [{ a: null, b: undefined }]);
    const lines = csv.split("\n");

    expect(lines[1]).toBe(",");
  });

  it("produces one row per record plus header", () => {
    const csv = toCsv(["id"], [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(4);
  });
});

describe("ImportService — opening-stock row validation via previewImport", () => {
  const service = new ImportService({} as never, {} as never, {} as never);

  function makeFile(csvContent: string): Express.Multer.File {
    return { buffer: Buffer.from(csvContent) } as Express.Multer.File;
  }

  it("returns no errors for a valid opening-stock row", async () => {
    const file = makeFile("sku,locationCode,quantity\nSKU1,LOC1,10.5");
    const result = await service.previewImport("org1", file, "opening-stock");

    expect(result.errors).toHaveLength(0);
    expect(result.validRows).toBe(1);
  });

  it("returns quantity error when quantity is not a valid number", async () => {
    const file = makeFile("sku,locationCode,quantity\nSKU1,LOC1,not-a-number");
    const result = await service.previewImport("org1", file, "opening-stock");

    const qtyError = result.errors.find((e: { field: string }) => e.field === "quantity");
    expect(qtyError).toBeDefined();
  });

  it("returns quantity error when quantity is zero", async () => {
    const file = makeFile("sku,locationCode,quantity\nSKU1,LOC1,0");
    const result = await service.previewImport("org1", file, "opening-stock");

    const qtyError = result.errors.find((e: { field: string }) => e.field === "quantity");
    expect(qtyError).toBeDefined();
  });

  it("returns quantity error when quantity is negative", async () => {
    const file = makeFile("sku,locationCode,quantity\nSKU1,LOC1,-5");
    const result = await service.previewImport("org1", file, "opening-stock");

    const qtyError = result.errors.find((e: { field: string }) => e.field === "quantity");
    expect(qtyError).toBeDefined();
  });

  it("returns sku error when sku is missing", async () => {
    const file = makeFile("sku,locationCode,quantity\n,LOC1,10");
    const result = await service.previewImport("org1", file, "opening-stock");

    const skuError = result.errors.find((e: { field: string }) => e.field === "sku");
    expect(skuError).toBeDefined();
  });

  it("returns error when quantity field is empty", async () => {
    const file = makeFile("sku,locationCode,quantity\nSKU1,LOC1,");
    const result = await service.previewImport("org1", file, "opening-stock");

    const qtyError = result.errors.find((e: { field: string }) => e.field === "quantity");
    expect(qtyError).toBeDefined();
  });

  it("maps columns from the CSV header for opening-stock", async () => {
    const file = makeFile("sku,locationCode,quantity,unitCost\nSKU1,LOC1,5,10");
    const result = await service.previewImport("org1", file, "opening-stock");

    expect(result.mappedFields).toContain("sku");
    expect(result.mappedFields).toContain("quantity");
  });
});
