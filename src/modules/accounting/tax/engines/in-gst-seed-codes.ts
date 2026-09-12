import type { SeedTaxCode } from "../tax.types";

/**
 * Seed rates. **As-of 2026-08 and explicitly not legal advice** — after the
 * 56th Council the working slabs are commonly described as 5/18/40 with a
 * 3% rate for bullion, and 12/28 largely retired. Kept as dated rows so a
 * correction is an INSERT, not a deploy.
 */
export function inGstSeedCodes(): SeedTaxCode[] {
  const from = "2017-07-01";
  const split = (total: number) => [
    { component: "CGST", jurisdiction: "IN", rateBp: total / 2, effectiveFrom: from },
    { component: "SGST", jurisdiction: "IN", rateBp: total / 2, effectiveFrom: from },
    { component: "UTGST", jurisdiction: "IN", rateBp: total / 2, effectiveFrom: from },
    { component: "IGST", jurisdiction: "IN", rateBp: total, effectiveFrom: from },
  ];

  return [
    {
      code: "IN_GST_18",
      name: "GST 18%",
      category: "standard",
      description: "Standard rate — most services, including SaaS",
      rates: split(1800),
    },
    {
      code: "IN_GST_5",
      name: "GST 5%",
      category: "reduced",
      rates: split(500),
    },
    {
      code: "IN_GST_3",
      name: "GST 3%",
      category: "super_reduced",
      description: "Bullion and specified goods",
      rates: split(300),
    },
    {
      code: "IN_GST_40",
      name: "GST 40%",
      category: "standard",
      description: "Demerit rate introduced by the 56th Council",
      rates: split(4000),
    },
    {
      code: "IN_GST_0",
      name: "GST 0% / exempt",
      category: "zero",
      rates: split(0),
    },
    {
      code: "IN_RCM_18",
      name: "GST 18% reverse charge",
      category: "reverse_charge",
      description: "Recipient accounts for the tax (GTA, legal, import of services)",
      rates: split(1800),
    },
    {
      code: "IN_EXP_0",
      name: "Export — zero rated",
      category: "zero",
      description: "Export under LUT; set exportWithIgst to charge IGST instead",
      rates: [{ component: "IGST", jurisdiction: "IN", rateBp: 0, effectiveFrom: from }],
    },
    // Legacy slabs, so historical documents and migrations still resolve.
    { code: "IN_GST_12", name: "GST 12% (legacy)", category: "reduced", rates: split(1200) },
    { code: "IN_GST_28", name: "GST 28% (legacy)", category: "standard", rates: split(2800) },
  ];
}
