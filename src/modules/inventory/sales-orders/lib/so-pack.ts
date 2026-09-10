import { and, eq } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { invPackages, invPackageLines, invSalesOrders } from "../../../../db/schema";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { runIdempotent, revivedScalar } from "../../stock-engine/idempotency";
import { shelfLines } from "../../shipments/packing-reconciliation";
import { cmpDec } from "../../stock-engine/decimal";
import type { PackSoInput } from "../dto/inv-sales-orders.schemas";
import type { FulfilmentDeps } from "./so-pick-pack";

/**
 * Packing a sales order, split out of `so-pick-pack.ts` so neither file sits
 * above the 300-line ratchet. Picking takes stock off the shelf; packing puts it
 * in a carton — two steps, two files.
 */
export async function packSo(
    deps: FulfilmentDeps,
    orgId: string,
    soId: number,
    userId: string,
    data: PackSoInput,
    idempotencyKey: string,
  ) {
    const settings = await deps.settingsService.get(orgId);

    const packageId = await deps.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.pack", soId, data },
        async () => {
          // B6. Read and checked *inside* the claim, which is the only place the
          // guard can be both correct and replay-safe. Outside it, a client
          // retrying after a network timeout on a pack that had already
          // committed was refused with "must be PICKED" — the status its own
          // first run had just moved to PACKED — so the key protected nothing on
          // the one path idempotency exists for. Inside, the replay branch
          // returns the stored package before the guard is reached, and a first
          // run that fails the guard rolls the claim back with it.
          const so = await tx.query.invSalesOrders.findFirst({
            where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
            columns: { id: true, status: true },
          });
          if (!so) throw new NotFoundException("Sales order not found");
          if (so.status !== "PICKED") {
            throw new BadRequestException("Sales order must be PICKED before packing");
          }

          let created: number | null = null;

          if (settings.packageRequiredForShipping) {
            const packageNumber = await deps.numSeq.next(orgId, "PACKAGE", tx);

            /**
             * B6. Found through the *lines*, not through `inv_pick_lists.so_id`.
             *
             * A wave's header carries a null `so_id` — that is what
             * distinguishes it from a single-order pick — so this lookup
             * returned nothing for a wave-picked order and packing raised an
             * **empty** package: a document asserting that a carton holding
             * three units holds none, closed, and shipped on. B4 found and fixed
             * the identical defect in `shipSo`; this is the same join.
             *
             * B7. It is now literally the same join — the one `shelfLines` owns
             * — rather than a third copy of it. The copies had already drifted:
             * this one, like shipping's, read `quantity_picked` alone and so
             * packed nothing for a substituted line, putting the swapped-in
             * units in no carton at all.
             */
            const pickedLines = await shelfLines(tx, orgId, soId);

            const [pkg] = await tx.insert(invPackages).values({
              orgId,
              packageNumber,
              // B6. The carton knows which order it holds, so the bench can
              // reconcile a scan and the packing queue can be read off the
              // cartons rather than off the order's status.
              soId,
              weight: data.weight?.toFixed(4),
              dimensionsL: data.dimensionsL?.toFixed(2),
              dimensionsW: data.dimensionsW?.toFixed(2),
              dimensionsH: data.dimensionsH?.toFixed(2),
              status: "CLOSED",
              createdBy: userId,
            }).returning();

            created = pkg!.id;

            const packageLinesValues = pickedLines
              // A line closed by an exception can hold zero, and a carton line
              // for nothing is a manifest entry nobody can act on.
              .filter((line) => cmpDec(line.quantity, "0") !== 0)
              .map((line) => ({
                orgId,
                packageId: pkg!.id,
                productVariantId: line.productVariantId,
                lotId: line.lotId,
                serialId: line.serialId,
                quantity: line.quantity,
              }));

            if (packageLinesValues.length > 0) {
              await tx.insert(invPackageLines).values(packageLinesValues);
            }
          }

          await tx.update(invSalesOrders)
            .set({ status: "PACKED", updatedAt: new Date() })
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

          return created;
        },
        (stored) => {
          const value = revivedScalar(stored);
          return value === null || value === undefined ? null : Number(value);
        },
      ),
    );

    await deps.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await deps.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return { soId, status: "PACKED", packageId: packageId ?? undefined };
  }
