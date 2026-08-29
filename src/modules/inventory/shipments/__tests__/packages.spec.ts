import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { PackagesService } from "../packages.service";
import { INV_ERRORS } from "../../stock-engine/stock-engine.types";

function limitChain(result: unknown[]) {
  const limit = jest.fn().mockResolvedValue(result);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

function directWhereChain(result: unknown[]) {
  const where = jest.fn().mockResolvedValue(result);
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  return { set };
}

function makeCache(cachedResult: unknown) {
  return {
    cachedVersioned: jest.fn().mockResolvedValue(cachedResult),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAudit() {
  return { insert: jest.fn().mockResolvedValue(undefined) };
}

function makeNumSeq() {
  return { next: jest.fn().mockResolvedValue("PKG-001") };
}

const ORG = "org1";
const USER = "u1";
const PKG_ID = 1;
const SO_ID = 20;
const VARIANT = 5;

const closedPkg = { id: PKG_ID, orgId: ORG, status: "CLOSED", lines: [] };

/**
 * A shelf row exactly as `db.execute` hands one back from `shelfLines`, which
 * `pickedQuantities` is now the per-variant view of. It used to be the old
 * `(product_variant_id, quantity_picked)` pair from a private copy of the join.
 */
const pickedRow = (productVariantId: number, quantity: string) => ({
  pick_line_id: 100 + productVariantId,
  so_line_id: 1,
  product_variant_id: productVariantId,
  location_id: 1,
  lot_id: null,
  serial_id: null,
  quantity,
  substituted: false,
});
const packedRow = (productVariantId: number, quantity: string) => ({
  product_variant_id: productVariantId,
  quantity,
});

/**
 * No carton chosen in most fixtures, so the fit check never runs. Present
 * because the constructor needs it, not because it is under test here — except
 * where a test names it.
 */
function makeCartonization(assertFits = async () => undefined) {
  return { assertFits, suggest: async () => ({}) };
}

/** Unrestricted scope: these are behaviour tests, not scope tests. */
function makeWarehouseScope() {
  return {
    resolve: async () => null,
    forUser: async () => ({ key: "all", isEmpty: false, unrestricted: true, anyOf: null }),
    assertWarehouseVisible: async () => undefined,
    assertLocationVisible: async () => undefined,
  };
}

function makeBarcode(scan: unknown = { lookup: { type: "not_found" } }) {
  return { scan: jest.fn().mockResolvedValue(scan) };
}

function makeService(db: unknown, overrides: { cartonization?: unknown; barcode?: unknown } = {}) {
  return new PackagesService(
    db as never,
    makeCache(closedPkg) as never,
    makeNumSeq() as never,
    (overrides.cartonization ?? makeCartonization()) as never,
    makeAudit() as never,
    makeWarehouseScope() as never,
    (overrides.barcode ?? makeBarcode()) as never,
  );
}

describe("PackagesService.close", () => {
  it("succeeds when the order's cartons hold no more than was picked", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: SO_ID, shipmentId: null, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "3.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines)),
      execute: jest.fn()
        .mockResolvedValueOnce([pickedRow(VARIANT, "5.0000")])
        .mockResolvedValueOnce([packedRow(VARIANT, "3.0000")]),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).resolves.toBeDefined();
    // The package's own attribution answers, so the shipment is never read.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("throws PACKAGE_CONTENT_MISMATCH when the cartons hold more than was picked", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: SO_ID, shipmentId: null, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "6.0000" }];

    const db = () => ({
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines)),
      execute: jest.fn()
        .mockResolvedValueOnce([pickedRow(VARIANT, "5.0000")])
        .mockResolvedValueOnce([packedRow(VARIANT, "6.0000")]),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    });

    await expect(makeService(db()).close(ORG, USER, PKG_ID)).rejects.toThrow(BadRequestException);
    await expect(makeService(db()).close(ORG, USER, PKG_ID)).rejects.toThrow(
      INV_ERRORS.PACKAGE_CONTENT_MISMATCH,
    );
  });

  it("counts a sibling carton, so an order split across two boxes cannot be double-packed", async () => {
    // Each carton on its own is within the picked quantity; together they are
    // not. A per-package check waves both through.
    const pkg = { id: PKG_ID, orgId: ORG, soId: SO_ID, shipmentId: null, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "3.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines)),
      execute: jest.fn()
        .mockResolvedValueOnce([pickedRow(VARIANT, "5.0000")])
        .mockResolvedValueOnce([packedRow(VARIANT, "6.0000")]),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).rejects.toThrow(
      INV_ERRORS.PACKAGE_CONTENT_MISMATCH,
    );
  });

  it("falls back to the shipment's order for a package raised before the link existed", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: null, shipmentId: 10, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "3.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([{ soId: SO_ID }])),
      execute: jest.fn()
        .mockResolvedValueOnce([pickedRow(VARIANT, "5.0000")])
        .mockResolvedValueOnce([packedRow(VARIANT, "3.0000")]),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).resolves.toBeDefined();
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("succeeds when the shipment names no order", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: null, shipmentId: 10, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "999.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([{ soId: null }])),
      execute: jest.fn(),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).resolves.toBeDefined();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("succeeds when the package belongs to no order and no shipment", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: null, shipmentId: null, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "50.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines)),
      execute: jest.fn(),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).resolves.toBeDefined();
  });

  it("refuses a carton the contents do not fit", async () => {
    // INV-206. The check existed and nothing ever wrote `carton_type_id`, so it
    // could not run; the carton now arrives with the close request.
    const pkg = { id: PKG_ID, orgId: ORG, soId: null, shipmentId: null, cartonTypeId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: VARIANT, quantity: "2.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([{ id: 7 }])),
      execute: jest.fn(),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const cartonization = makeCartonization(async () => {
      throw new BadRequestException("Contents do not fit SMALL: an item is longer than the carton");
    });

    await expect(
      makeService(db, { cartonization }).close(ORG, USER, PKG_ID, { cartonTypeId: 7 }),
    ).rejects.toThrow(/do not fit/);
  });

  it("throws NotFoundException when the package does not exist", async () => {
    const db = {
      select: jest.fn().mockReturnValueOnce(limitChain([])),
      execute: jest.fn(),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws ConflictException when the package is already CLOSED", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: null, shipmentId: null, cartonTypeId: null, status: "CLOSED" };
    const db = {
      select: jest.fn().mockReturnValueOnce(limitChain([pkg])),
      execute: jest.fn(),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).rejects.toThrow(ConflictException);
  });

  it("succeeds when several variants are each within what was picked", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, soId: SO_ID, shipmentId: null, cartonTypeId: null, status: "OPEN" };
    const lines = [
      { packageId: PKG_ID, productVariantId: 5, quantity: "3.0000" },
      { packageId: PKG_ID, productVariantId: 7, quantity: "2.0000" },
    ];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines)),
      execute: jest.fn()
        .mockResolvedValueOnce([pickedRow(5, "4.0000"), pickedRow(7, "3.0000")])
        .mockResolvedValueOnce([packedRow(5, "3.0000"), packedRow(7, "2.0000")]),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    await expect(makeService(db).close(ORG, USER, PKG_ID)).resolves.toBeDefined();
  });
});

/**
 * The scan path runs entirely inside one claimed transaction, so the mock has to
 * invoke the transaction callback — a bare `jest.fn()` here would silently void
 * every assertion below.
 */
function makeTx(select: jest.Mock, execute: jest.Mock) {
  return {
    select,
    execute,
    // `runIdempotent` claims on the way in and marks COMPLETED on the way out.
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
    query: { invIdempotencyKeys: { findFirst: jest.fn().mockResolvedValue(undefined) } },
  };
}

function makeScanDb(select: jest.Mock, execute: jest.Mock) {
  const tx = makeTx(select, execute);
  return {
    select,
    execute,
    transaction: jest.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
  };
}

describe("PackagesService.scan", () => {
  const openPkg = { status: "OPEN", soId: SO_ID };
  const KEY = "scan-key-1";

  it("refuses a scan that would take the order past what was picked", async () => {
    // The refusal has to happen here, at the bench, while the goods are in the
    // packer's hand. Caught at close it is a carton to unpack.
    const db = makeScanDb(
      jest.fn().mockReturnValueOnce(limitChain([openPkg])),
      jest.fn()
        // The advisory lock, then the two totals.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([pickedRow(VARIANT, "2.0000")])
        .mockResolvedValueOnce([packedRow(VARIANT, "2.0000")]),
    );

    await expect(
      makeService(db).scan(ORG, USER, PKG_ID, { productVariantId: VARIANT, quantity: "1" }, KEY),
    ).rejects.toThrow(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);
  });

  it("refuses a SKU nobody picked for this order", async () => {
    const db = makeScanDb(
      jest.fn().mockReturnValueOnce(limitChain([openPkg])),
      jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([pickedRow(VARIANT, "5.0000")])
        .mockResolvedValueOnce([]),
    );

    await expect(
      makeService(db).scan(ORG, USER, PKG_ID, { productVariantId: 99, quantity: "1" }, KEY),
    ).rejects.toThrow(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);
  });

  it("refuses a scan into a package that is packing no sales order", async () => {
    const db = makeScanDb(
      jest.fn().mockReturnValueOnce(limitChain([{ ...openPkg, soId: null }])),
      jest.fn(),
    );

    await expect(
      makeService(db).scan(ORG, USER, PKG_ID, { productVariantId: VARIANT, quantity: "1" }, KEY),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses a scan into a package that is already closed", async () => {
    const db = makeScanDb(
      jest.fn().mockReturnValueOnce(limitChain([{ ...openPkg, status: "CLOSED" }])),
      jest.fn(),
    );

    await expect(
      makeService(db).scan(ORG, USER, PKG_ID, { productVariantId: VARIANT, quantity: "1" }, KEY),
    ).rejects.toThrow(ConflictException);
  });

  it("refuses a payload that names no product before claiming a key against it", async () => {
    const db = makeScanDb(jest.fn(), jest.fn());
    const barcode = makeBarcode({ lookup: { type: "not_found" }, warnings: [] });

    await expect(
      makeService(db, { barcode }).scan(ORG, USER, PKG_ID, { scannedPayload: "nonsense", quantity: "1" }, KEY),
    ).rejects.toThrow(/does not identify a product/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("demands a key", async () => {
    // `runIdempotent` refuses an absent one, so a caller that forgot cannot
    // quietly run unguarded.
    const db = makeScanDb(
      jest.fn().mockReturnValueOnce(limitChain([openPkg])),
      jest.fn(),
    );

    await expect(
      makeService(db).scan(ORG, USER, PKG_ID, { productVariantId: VARIANT, quantity: "1" }, ""),
    ).rejects.toThrow(/Idempotency-Key/);
  });
});
