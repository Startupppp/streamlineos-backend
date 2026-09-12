import { BadRequestException } from "@nestjs/common";

/**
 * E3 — the pharmacy rules, with no database in them.
 *
 * Two questions, and they are answered in different places for a reason.
 *
 * **At receipt, one thing blocks.** A SKU flagged `mrpRequired` may not be
 * received without the MRP printed on the cartons, and a lot-tracked pharmacy
 * SKU may not be received without a batch number and an expiry. These block
 * because they are unrecoverable: once the carton is broken and the strips are
 * on the shelf, nobody can reconstruct what was printed on it, and a batch with
 * no expiry is invisible to FEFO, to the near-expiry sweep and to the allocator's
 * expired-lot refusal — every one of which then silently does nothing.
 *
 * **At dispense, nothing blocks.** Look-alike/sound-alike and high-alert are
 * warnings, because the drug is legitimately dispensable and a block on every
 * LASA line is a block that gets switched off inside a week. What makes them a
 * safety feature is not their severity, it is *where* they are raised: at the
 * shelf, on the scan, naming the products this one is confusable with. A banner
 * on a catalogue page nobody has open during a pick is decoration.
 *
 * `ACKNOWLEDGE` is the strongest disposition and still not a block — it asks the
 * caller to require a positive confirmation rather than a passive banner. The
 * distinction is the caller's to honour, which is why it is a value in the
 * payload rather than a convention in a comment.
 */

export type InvDrugSchedule = "OTC" | "H" | "H1" | "X" | "NARCOTIC";

/** The SKU's pharmacy classification. `null` means the pack is off. */
export interface PharmacyClassification {
  /** The SKU's *currently printed* MRP in paise — a default, never the ceiling a sale is bound by. */
  mrpPaise: number | null;
  mrpRequired: boolean;
  drugSchedule: InvDrugSchedule | null;
  isHighAlert: boolean;
  lasaGroup: string | null;
  trackingMethod: "NONE" | "LOT" | "SERIAL" | null;
}

export type PharmacyAlertCode =
  | "LASA"
  | "HIGH_ALERT"
  | "PRESCRIPTION_REQUIRED"
  | "REGISTER_ENTRY_REQUIRED";

export interface PharmacyAlert {
  code: PharmacyAlertCode;
  /**
   * `WARN` shows and does not interrupt. `ACKNOWLEDGE` asks the caller to take a
   * positive confirmation before the line is committed. Neither refuses the
   * dispense — see the header.
   */
  disposition: "WARN" | "ACKNOWLEDGE";
  message: string;
}

/** A SKU that shares this one's LASA group: the reason the warning is useful. */
export interface ConfusableSku {
  productId: number;
  sku: string;
  name: string;
}

export interface DispensingSafety {
  alerts: PharmacyAlert[];
  /**
   * Stated in the payload rather than left to be inferred. A caller that reads
   * `alerts.length > 0` as "refuse" turns a warning into an outage, and a caller
   * that reads it as "ignore" loses the warning entirely.
   */
  blocksDispense: false;
  acknowledgementRequired: boolean;
}

const PRESCRIPTION_SCHEDULES: ReadonlySet<InvDrugSchedule> = new Set(["H", "H1", "X", "NARCOTIC"]);
/** The schedules whose sale has to be entered in a bound register. */
const REGISTER_SCHEDULES: ReadonlySet<InvDrugSchedule> = new Set(["H1", "X", "NARCOTIC"]);

export function resolveDispensingSafety(
  classification: PharmacyClassification,
  confusable: readonly ConfusableSku[],
): DispensingSafety {
  const alerts: PharmacyAlert[] = [];

  if (classification.lasaGroup) {
    // A group with no siblings in this catalogue is declared and not yet
    // confusable with anything stocked here. Saying so is more useful than
    // demanding a confirmation against nothing.
    alerts.push(
      confusable.length > 0
        ? {
            code: "LASA",
            disposition: "ACKNOWLEDGE",
            message: `Look-alike/sound-alike: confirm this is not ${confusable
              .map((c) => `${c.name} (${c.sku})`)
              .join(", ")}.`,
          }
        : {
            code: "LASA",
            disposition: "WARN",
            message: `Marked look-alike/sound-alike in group "${classification.lasaGroup}", but no other product in this catalogue shares that group.`,
          },
    );
  }

  if (classification.isHighAlert) {
    alerts.push({
      code: "HIGH_ALERT",
      disposition: "ACKNOWLEDGE",
      message: "High-alert medication: confirm the product, strength and quantity before picking.",
    });
  }

  const schedule = classification.drugSchedule;
  if (schedule && PRESCRIPTION_SCHEDULES.has(schedule)) {
    alerts.push({
      code: "PRESCRIPTION_REQUIRED",
      disposition: schedule === "H" ? "WARN" : "ACKNOWLEDGE",
      message: `Schedule ${schedule}: dispense only against a valid prescription.`,
    });
  }
  if (schedule && REGISTER_SCHEDULES.has(schedule)) {
    alerts.push({
      code: "REGISTER_ENTRY_REQUIRED",
      disposition: "ACKNOWLEDGE",
      message: `Schedule ${schedule}: this sale must be entered in the register kept for it. StreamlineOS does not keep that register.`,
    });
  }

  return {
    alerts,
    blocksDispense: false,
    acknowledgementRequired: alerts.some((a) => a.disposition === "ACKNOWLEDGE"),
  };
}

/** What a receipt line has to carry for this SKU before it may be posted. */
export interface ReceiptRequirements {
  mrpRequired: boolean;
  lotRequired: boolean;
  expiryRequired: boolean;
  /** The catalogue MRP, offered as the default a line snapshots — not an authority. */
  suggestedMrpPaise: number | null;
}

export function resolveReceiptRequirements(
  classification: PharmacyClassification | null,
): ReceiptRequirements {
  // Pack off: E3's fields do not exist on the form and nothing about them is
  // required. That is the whole meaning of the flag.
  if (!classification) {
    return { mrpRequired: false, lotRequired: false, expiryRequired: false, suggestedMrpPaise: null };
  }
  const lotTracked = classification.trackingMethod === "LOT";
  return {
    mrpRequired: classification.mrpRequired,
    lotRequired: lotTracked,
    expiryRequired: lotTracked,
    suggestedMrpPaise: classification.mrpPaise,
  };
}

/** What a receipt line claims about the goods that arrived. */
export interface ReceiptLineFacts {
  mrpPaise?: number | null;
  purchaseRatePaise?: number | null;
  lotNumber?: string | null;
  expiryDate?: string | null;
}

/**
 * Refuses a receipt line that cannot be completed later.
 *
 * Every refusal here is about information that stops existing the moment the
 * delivery is put away. Nothing is refused for being unusual.
 */
export function assertReceiptLine(
  classification: PharmacyClassification | null,
  line: ReceiptLineFacts,
  label: string,
): void {
  const requirements = resolveReceiptRequirements(classification);

  if (requirements.mrpRequired && !line.mrpPaise) {
    throw new BadRequestException({
      code: "MRP_REQUIRED",
      message: `${label} requires the MRP printed on the pack. Once the carton is opened the printed price is not recoverable, so it has to be recorded at the door.`,
    });
  }
  if (requirements.lotRequired && !line.lotNumber?.trim()) {
    throw new BadRequestException({
      code: "LOT_REQUIRED",
      message: `${label} is batch-tracked and needs a batch number.`,
    });
  }
  if (requirements.expiryRequired && !line.expiryDate) {
    throw new BadRequestException({
      code: "EXPIRY_REQUIRED",
      message: `${label} is batch-tracked and needs an expiry date. A batch with no expiry is invisible to FEFO allocation, to the near-expiry sweep and to the expired-lot refusal.`,
    });
  }
  // Almost always the MRP typed into the rate field. Buying above the printed
  // ceiling is a guaranteed loss on every unit, so refusing it costs nothing and
  // catches the transposition at the only moment it is cheap to fix.
  if (line.mrpPaise && line.purchaseRatePaise && line.purchaseRatePaise > line.mrpPaise) {
    throw new BadRequestException({
      code: "PURCHASE_RATE_ABOVE_MRP",
      message: `${label} was received at a purchase rate above the MRP printed on the pack. Check the two figures have not been swapped.`,
    });
  }
}
