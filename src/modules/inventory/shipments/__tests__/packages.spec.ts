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

function joinWhereChain(result: unknown[]) {
  const where = jest.fn().mockResolvedValue(result);
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  return { from };
}

function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  return { set };
}

function makeCache(cachedResult: unknown) {
  return {
    cached: jest.fn().mockResolvedValue(cachedResult),
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
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

const closedPkg = { id: PKG_ID, orgId: ORG, status: "CLOSED", lines: [] };

describe("PackagesService.close", () => {
  it("succeeds when package qty is within picked qty", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, shipmentId: 10, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: 5, quantity: "3.0000" }];
    const shipment = { id: 10, orgId: ORG, soId: 20 };
    const pickLines = [{ productVariantId: 5, quantityPicked: "5.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([shipment]))
        .mockReturnValueOnce(joinWhereChain(pickLines)),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).resolves.toBeDefined();
  });

  it("throws BadRequestException(PACKAGE_CONTENT_MISMATCH) when package qty exceeds picked qty", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, shipmentId: 10, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: 5, quantity: "6.0000" }];
    const shipment = { id: 10, orgId: ORG, soId: 20 };
    const pickLines = [{ productVariantId: 5, quantityPicked: "5.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([shipment]))
        .mockReturnValueOnce(joinWhereChain(pickLines))
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([shipment]))
        .mockReturnValueOnce(joinWhereChain(pickLines)),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).rejects.toThrow(BadRequestException);
    await expect(service.close(ORG, USER, PKG_ID)).rejects.toThrow(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);
  });

  it("succeeds when shipment has no soId (no pick list validation needed)", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, shipmentId: 10, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: 5, quantity: "999.0000" }];
    const shipment = { id: 10, orgId: ORG, soId: null };

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([shipment])),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).resolves.toBeDefined();
  });

  it("succeeds when package has no shipmentId", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, shipmentId: null, status: "OPEN" };
    const lines = [{ packageId: PKG_ID, productVariantId: 5, quantity: "50.0000" }];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines)),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).resolves.toBeDefined();
  });

  it("throws NotFoundException when package does not exist", async () => {
    const db = {
      select: jest.fn().mockReturnValueOnce(limitChain([])),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws ConflictException when package is already CLOSED", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, shipmentId: null, status: "CLOSED" };

    const db = {
      select: jest.fn().mockReturnValueOnce(limitChain([pkg])),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).rejects.toThrow(ConflictException);
  });

  it("succeeds when multiple pick list lines cover all package lines", async () => {
    const pkg = { id: PKG_ID, orgId: ORG, shipmentId: 10, status: "OPEN" };
    const lines = [
      { packageId: PKG_ID, productVariantId: 5, quantity: "3.0000" },
      { packageId: PKG_ID, productVariantId: 7, quantity: "2.0000" },
    ];
    const shipment = { id: 10, orgId: ORG, soId: 20 };
    const pickLines = [
      { productVariantId: 5, quantityPicked: "4.0000" },
      { productVariantId: 7, quantityPicked: "3.0000" },
    ];

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(limitChain([pkg]))
        .mockReturnValueOnce(directWhereChain(lines))
        .mockReturnValueOnce(limitChain([shipment]))
        .mockReturnValueOnce(joinWhereChain(pickLines)),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    const service = new PackagesService(
      db as never,
      makeCache(closedPkg) as never,
      makeNumSeq() as never,
      makeAudit() as never,
    );

    await expect(service.close(ORG, USER, PKG_ID)).resolves.toBeDefined();
  });
});
