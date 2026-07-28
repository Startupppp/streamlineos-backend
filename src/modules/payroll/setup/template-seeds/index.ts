import type { PayrollTemplateSeed } from "../../payroll.types";
import { INDIAN_STANDARD_SEED, INDIAN_STARTUP_SEED } from "./indian-standard-seeds";
import { CONTRACTOR_SEED, GLOBAL_REMOTE_SEED } from "./contractor-global-seeds";
import { SALES_INCENTIVE_SEED } from "./sales-incentive-seed";
import { HOURLY_SEED, MANUFACTURING_SEED } from "./hourly-manufacturing-seeds";
import { STAFFING_SEED, EXECUTIVE_SEED } from "./staffing-executive-seeds";
import {
  US_STANDARD_SEED,
  UK_STANDARD_SEED,
  UAE_STANDARD_SEED,
  SG_STANDARD_SEED,
  AU_STANDARD_SEED,
} from "./country-standard-seeds";

export { OT_MULTIPLIER_DEFAULT } from "./hourly-manufacturing-seeds";

export const PAYROLL_TEMPLATE_SEEDS: PayrollTemplateSeed[] = [
  INDIAN_STANDARD_SEED,
  INDIAN_STARTUP_SEED,
  CONTRACTOR_SEED,
  SALES_INCENTIVE_SEED,
  GLOBAL_REMOTE_SEED,
  HOURLY_SEED,
  MANUFACTURING_SEED,
  STAFFING_SEED,
  EXECUTIVE_SEED,
  US_STANDARD_SEED,
  UK_STANDARD_SEED,
  UAE_STANDARD_SEED,
  SG_STANDARD_SEED,
  AU_STANDARD_SEED,
];
