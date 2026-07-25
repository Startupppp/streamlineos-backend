/**
 * Country pack maturity + entity isolation helpers (Phase 10).
 * India is the production calc baseline; other packs are pilot/templates only.
 */

import {
  COUNTRY_PACKS,
  getCountryPack,
  type CountryPack,
} from "../country-packs";
import { IN_STATUTORY_RULE_BUNDLE_VERSION } from "../../payroll/runs/lib/statutory-registry";

export type CountryPackMaturity = "production_baseline" | "pilot" | "template";

export interface CountryPackDescriptor {
  countryCode: string;
  countryName: string;
  currency: string;
  maturity: CountryPackMaturity;
  honestyLabel: string;
  /** Linked payroll statutory rule bundle when available */
  payrollStatutoryBundle: string | null;
  holidayCount: number;
  complianceRequirementCount: number;
  sensitiveFieldCount: number;
}

export interface EntityIsolationCheck {
  ok: boolean;
  message: string;
}

const MATURITY: Record<string, CountryPackMaturity> = {
  IN: "production_baseline",
  AE: "pilot",
  SG: "pilot",
  US: "pilot",
  GENERIC: "template",
};

function honestyFor(maturity: CountryPackMaturity, code: string): string {
  if (maturity === "production_baseline") {
    return `${code}: production payroll calc baseline (code registry). Not a legal-reviewed compliance pack for every jurisdiction.`;
  }
  if (maturity === "pilot") {
    return `${code}: pilot country pack — holidays/compliance seeds only. Payroll statutory calc remains India-first; do not claim full local payroll.`;
  }
  return `${code}: generic template only — configure local rules before production use.`;
}

export function listCountryPackDescriptors(): CountryPackDescriptor[] {
  return Object.keys(COUNTRY_PACKS).map((code) => describeCountryPack(code)!);
}

export function describeCountryPack(countryCode: string): CountryPackDescriptor | null {
  const pack = getCountryPack(countryCode);
  if (!pack) return null;
  const code = pack.countryCode.toUpperCase();
  const maturity = MATURITY[code] ?? "template";
  return {
    countryCode: pack.countryCode,
    countryName: pack.countryName,
    currency: pack.currency,
    maturity,
    honestyLabel: honestyFor(maturity, code),
    payrollStatutoryBundle: code === "IN" ? IN_STATUTORY_RULE_BUNDLE_VERSION : null,
    holidayCount: pack.defaultHolidays.length,
    complianceRequirementCount: pack.complianceRequirements.length,
    sensitiveFieldCount: pack.sensitiveFieldKeys.length,
  };
}

/**
 * Prevent applying entity A's country rules to entity B's runs.
 */
export function assertEntityCountryIsolation(
  entityCountryCode: string,
  requestedCountryCode: string,
): EntityIsolationCheck {
  const a = entityCountryCode.toUpperCase();
  const b = requestedCountryCode.toUpperCase();
  if (a === b) {
    return { ok: true, message: "Country codes match" };
  }
  return {
    ok: false,
    message: `Entity is country ${a}; cannot apply ${b} rules without changing the entity countryCode (contamination guard)`,
  };
}

export interface EntityReadinessItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

/**
 * Country-aware readiness for a payroll legal entity (registration fields).
 */
export function buildEntityReadiness(
  entity: {
    countryCode: string;
    baseCurrency: string;
    pan?: string | null;
    tan?: string | null;
    pfEstablishmentCode?: string | null;
    esiCode?: string | null;
    ptStateCode?: string | null;
    stateCode?: string | null;
  },
  pack: CountryPack | undefined,
): EntityReadinessItem[] {
  const code = entity.countryCode.toUpperCase();
  const items: EntityReadinessItem[] = [
    {
      key: "currency",
      label: "Base currency set",
      done: Boolean(entity.baseCurrency),
      detail: entity.baseCurrency || "Missing base currency",
    },
    {
      key: "country_pack",
      label: "Country pack available",
      done: Boolean(pack),
      detail: pack
        ? `${pack.countryName} (${pack.currency})`
        : "No pack — using GENERIC template",
    },
  ];

  if (code === "IN") {
    items.push(
      {
        key: "pan",
        label: "PAN registered",
        done: Boolean(entity.pan?.trim()),
        detail: entity.pan?.trim() ? "PAN on file" : "Required for TDS/compliance",
      },
      {
        key: "tan",
        label: "TAN registered",
        done: Boolean(entity.tan?.trim()),
        detail: entity.tan?.trim() ? "TAN on file" : "Required for TDS filing",
      },
      {
        key: "pf",
        label: "PF establishment code",
        done: Boolean(entity.pfEstablishmentCode?.trim()),
        detail: entity.pfEstablishmentCode?.trim()
          ? "PF code on file"
          : "Needed for PF ECR exports",
      },
      {
        key: "esi",
        label: "ESI code",
        done: Boolean(entity.esiCode?.trim()),
        detail: entity.esiCode?.trim()
          ? "ESI code on file"
          : "Optional until ESI is enabled",
      },
      {
        key: "pt_state",
        label: "PT state",
        done: Boolean((entity.ptStateCode ?? entity.stateCode)?.trim()),
        detail: (entity.ptStateCode ?? entity.stateCode)?.trim()
          ? `State ${(entity.ptStateCode ?? entity.stateCode)!.trim()}`
          : "State code drives PT/LWF slabs",
      },
    );
  } else {
    items.push({
      key: "local_registrations",
      label: "Local registrations",
      done: false,
      detail: "Pilot-only pack — capture local tax IDs in entity metadata before go-live",
    });
  }

  return items;
}

export function entityReadinessScore(items: EntityReadinessItem[]): {
  done: number;
  total: number;
  percent: number;
} {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}
