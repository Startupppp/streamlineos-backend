import { BadRequestException } from "@nestjs/common";
import { SettingsService } from "../settings.service";
import type { InvGstMode, InvSettingsRow } from "../../stock-engine/stock-engine.types";

/**
 * E1 — the packs, and the one rule that has to hold about them.
 *
 * Everything else about a pack is a hidden field or a hidden nav entry, which a
 * unit test cannot see. The rule that matters here is that an organisation
 * cannot end up with every pack off: the module would still be enabled, still
 * be reachable, and have no domain rules and no fields beyond the bare ledger —
 * indistinguishable from a broken deployment from the operator's side.
 */

function settingsRow(packs: InvSettingsRow["packs"], gstMode: InvGstMode = "REGULAR"): InvSettingsRow {
  return {
    allowNegativeStock: false,
    allowBackorders: false,
    reservationStrategy: "AUTO_ON_CONFIRM",
    defaultCostingMethod: "WEIGHTED_AVERAGE",
    expiryReservationPolicy: "BLOCK",
    inspectionOnReceipt: false,
    inspectionOnReturn: false,
    overReceiptTolerancePct: "0.00",
    requirePoApproval: false,
    adjustmentApprovalThreshold: null,
    autoReserveOnConfirm: true,
    allowPartialShipment: true,
    packageRequiredForShipping: false,
    channelPublishPolicy: null,
    packs,
    gstMode,
  };
}

function buildService(current: InvSettingsRow["packs"], gstMode: InvGstMode = "REGULAR") {
  const update = jest.fn(async () => settingsRow(current, gstMode));
  const invSettings = {
    get: jest.fn(async () => settingsRow(current, gstMode)),
    update,
  };
  const cache = { invalidate: jest.fn(async () => undefined) };
  const service = new SettingsService(
    {} as never,
    invSettings as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
  );
  return { service, update };
}

describe("E1 pack flags", () => {
  const warehouseOnly = { warehouse: true, kirana: false, pharmacy: false, gst: false };

  it("defaults to warehouse only", async () => {
    const { service } = buildService(warehouseOnly);
    await expect(service.getPacks("org1")).resolves.toEqual(warehouseOnly);
  });

  it("turns a pack on without disturbing the others", async () => {
    const { service, update } = buildService(warehouseOnly);
    await service.updateSettings("org1", "u1", { packGst: true });
    expect(update).toHaveBeenCalledWith("org1", { packGst: true }, "u1");
  });

  it("refuses to leave every pack off", async () => {
    const { service, update } = buildService(warehouseOnly);
    await expect(
      service.updateSettings("org1", "u1", { packWarehouse: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows turning warehouse off when another pack carries the module", async () => {
    const { service, update } = buildService({
      warehouse: true,
      kirana: true,
      pharmacy: false,
      gst: false,
    });
    await service.updateSettings("org1", "u1", { packWarehouse: false });
    expect(update).toHaveBeenCalledWith("org1", { packWarehouse: false }, "u1");
  });

  it("reads the unsupplied flags from the stored row rather than assuming false", async () => {
    // Patching only `packWarehouse` must not be read as "kirana, pharmacy and gst
    // are all off too" — a partial PATCH that silently disabled every other pack
    // is exactly the shape of bug this guard exists for.
    const { service, update } = buildService({
      warehouse: false,
      kirana: false,
      pharmacy: true,
      gst: false,
    });
    await service.updateSettings("org1", "u1", { packWarehouse: false });
    expect(update).toHaveBeenCalled();
  });

  /**
   * E2 — the registration mode is only answerable while the pack that asks the
   * question is on.
   */
  it("refuses the composition scheme while the gst pack is off", async () => {
    const { service, update } = buildService(warehouseOnly);
    await expect(
      service.updateSettings("org1", "u1", { gstMode: "COMPOSITION" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts the composition scheme when the gst pack is turned on in the same change", async () => {
    const { service, update } = buildService(warehouseOnly);
    await service.updateSettings("org1", "u1", { packGst: true, gstMode: "COMPOSITION" });
    expect(update).toHaveBeenCalledWith("org1", { packGst: true, gstMode: "COMPOSITION" }, "u1");
  });

  it("refuses to turn the gst pack off underneath a composition registration", async () => {
    // The inverse of the rule above, and the one that would otherwise be missed:
    // the mode is already COMPOSITION and the patch only touches the pack, so
    // nothing in the request mentions GST mode at all.
    const { service, update } = buildService(
      { warehouse: true, kirana: false, pharmacy: false, gst: true },
      "COMPOSITION",
    );
    await expect(
      service.updateSettings("org1", "u1", { packGst: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
});
