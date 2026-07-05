export type StatutoryPackItemKind = "EMPLOYEE_DEDUCTION" | "EMPLOYER_CONTRIBUTION" | "WITHHOLDING";
export type StatutoryPackCalcMethod = "PERCENT_OF_BASIC" | "PERCENT_OF_GROSS" | "FIXED" | "BRACKETS";

export interface StatutoryPackItem {
  key: string;
  label: string;
  kind: StatutoryPackItemKind;
  calc: {
    method: StatutoryPackCalcMethod;
    percent?: string;
    employerPercent?: string;
    fixedAmount?: string;
    wageCeilingMonthly?: string | null;
    wageFloorMonthly?: string | null;
    brackets?: { upToMonthly: string | null; percent: string }[];
  };
  componentCode: string;
  enabledByDefault: boolean;
  note?: string;
}

export interface StatutoryPack {
  country: string;
  countryName: string;
  currency: string;
  items: StatutoryPackItem[];
  complianceChecklist: { key: string; label: string; detail: string }[];
  taxRegimeApplicable: boolean;
}

const IN_PACK: StatutoryPack = {
  country: "IN",
  countryName: "India",
  currency: "INR",
  taxRegimeApplicable: true,
  items: [
    {
      key: "PF_EMP",
      label: "Provident Fund (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_BASIC", percent: "12", wageCeilingMonthly: "15000.00" },
      componentCode: "PF_EMP",
      enabledByDefault: true,
    },
    {
      key: "PF_ER",
      label: "Provident Fund (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_BASIC", percent: "12", wageCeilingMonthly: "15000.00" },
      componentCode: "PF_ER",
      enabledByDefault: true,
    },
    {
      key: "ESI_EMP",
      label: "ESI (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "0.75", wageCeilingMonthly: "21000.00" },
      componentCode: "ESI_EMP",
      enabledByDefault: false,
      note: "Eligibility ceiling — ESI does not apply when gross exceeds ₹21,000/mo",
    },
    {
      key: "ESI_ER",
      label: "ESI (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "3.25", wageCeilingMonthly: "21000.00" },
      componentCode: "ESI_ER",
      enabledByDefault: false,
      note: "Eligibility ceiling — ESI does not apply when gross exceeds ₹21,000/mo",
    },
    {
      key: "PT",
      label: "Professional Tax",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "FIXED", fixedAmount: "200.00" },
      componentCode: "PT",
      enabledByDefault: false,
    },
    {
      key: "TDS",
      label: "Tax Deducted at Source",
      kind: "WITHHOLDING",
      calc: { method: "BRACKETS", brackets: [] },
      componentCode: "TDS",
      enabledByDefault: false,
      note: "Computed via tdsMode: DECLARATION (slab-based) or FLAT (percent) per policy config",
    },
  ],
  complianceChecklist: [
    { key: "epfo_registration", label: "Register entity with EPFO", detail: "Required before first PF contribution. Obtain establishment code from regional EPFO office." },
    { key: "esic_registration", label: "Register entity with ESIC", detail: "Required if any employee earns ≤ ₹21,000/mo. Obtain ESIC code from regional office." },
    { key: "pt_registration", label: "Register for Professional Tax", detail: "State-specific registration required; not applicable in all states." },
    { key: "tan_registration", label: "Obtain TAN for TDS filing", detail: "Apply for Tax Deduction Account Number (TAN) before deducting TDS." },
    { key: "pf_ecr_filing", label: "File monthly PF/ESI ECR", detail: "Electronic Challan-cum-Return due by 15th of the following month." },
    { key: "tds_24q_quarterly", label: "File Form 24Q quarterly", detail: "TDS return for salary payments due within 31 days after each quarter end." },
    { key: "form_16_annual", label: "Issue Form 16 to employees", detail: "Must be issued by May 31st for the preceding financial year." },
    { key: "pf_annual_return", label: "File annual PF/ESI returns", detail: "Annual returns to be filed with EPFO/ESIC as required by applicable rules." },
  ],
};

const US_PACK: StatutoryPack = {
  country: "US",
  countryName: "United States",
  currency: "USD",
  taxRegimeApplicable: false,
  items: [
    {
      key: "SS_EMP",
      label: "Social Security (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "6.2", wageCeilingMonthly: "14675.00" },
      componentCode: "SS_EMP",
      enabledByDefault: true,
      note: "2026 Social Security wage base ~$176,100/yr ($14,675/mo). Rate 6.2%.",
    },
    {
      key: "SS_ER",
      label: "Social Security (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "6.2", wageCeilingMonthly: "14675.00" },
      componentCode: "SS_ER",
      enabledByDefault: true,
      note: "Employer matches employee Social Security contribution 6.2% up to the same wage base.",
    },
    {
      key: "MEDICARE_EMP",
      label: "Medicare (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "1.45", wageCeilingMonthly: null },
      componentCode: "MEDICARE_EMP",
      enabledByDefault: true,
      note: "No wage ceiling. Additional 0.9% applies over $200,000/yr (handle via year-end adjustment).",
    },
    {
      key: "MEDICARE_ER",
      label: "Medicare (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "1.45", wageCeilingMonthly: null },
      componentCode: "MEDICARE_ER",
      enabledByDefault: true,
    },
    {
      key: "FWT",
      label: "Federal Withholding Tax",
      kind: "WITHHOLDING",
      calc: {
        method: "BRACKETS",
        brackets: [
          { upToMonthly: null, percent: "12" },
        ],
      },
      componentCode: "FWT",
      enabledByDefault: true,
      note: "Simplified withholding at 12% flat — configure per employee W-4 for accurate withholding.",
    },
  ],
  complianceChecklist: [
    { key: "ein_registration", label: "Obtain Employer Identification Number (EIN)", detail: "Apply with IRS (Form SS-4) before making first payroll payment." },
    { key: "state_registration", label: "Register for state payroll tax accounts", detail: "Register with each state's department of revenue and labor for income tax and unemployment." },
    { key: "w4_collection", label: "Collect Form W-4 from each employee", detail: "Required before first paycheck to determine federal withholding allowances." },
    { key: "form_941_quarterly", label: "File Form 941 quarterly", detail: "Federal employer quarterly tax return due by last day of month following quarter end." },
    { key: "fica_deposit", label: "Deposit FICA taxes per deposit schedule", detail: "Semi-weekly or monthly deposits depending on lookback period liability." },
    { key: "w2_annual", label: "Issue Form W-2 by January 31st", detail: "Annual wage and tax statement to each employee; also file with SSA." },
    { key: "futa_940", label: "File Form 940 annually (FUTA)", detail: "Federal Unemployment Tax Act return due January 31st for prior calendar year." },
  ],
};

const UK_PACK: StatutoryPack = {
  country: "GB",
  countryName: "United Kingdom",
  currency: "GBP",
  taxRegimeApplicable: false,
  items: [
    {
      key: "PAYE",
      label: "PAYE Income Tax Withholding",
      kind: "WITHHOLDING",
      calc: {
        method: "BRACKETS",
        brackets: [
          { upToMonthly: "1048", percent: "0" },
          { upToMonthly: "4189", percent: "20" },
          { upToMonthly: null, percent: "40" },
        ],
      },
      componentCode: "PAYE",
      enabledByDefault: true,
      note: "Simplified 2026/27 PAYE brackets: 0% to £1,048/mo (personal allowance), 20% to £4,189/mo, 40% above. Use HMRC payroll software for exact calculation.",
    },
    {
      key: "NI_EMP",
      label: "National Insurance (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: {
        method: "BRACKETS",
        brackets: [
          { upToMonthly: "1048", percent: "0" },
          { upToMonthly: "4189", percent: "8" },
          { upToMonthly: null, percent: "2" },
        ],
      },
      componentCode: "NI_EMP",
      enabledByDefault: true,
      note: "Class 1 NI employee contributions 2026/27 (simplified): 0% below primary threshold £1,048/mo, 8% up to UEL £4,189/mo, 2% above UEL.",
    },
    {
      key: "NI_ER",
      label: "National Insurance (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: {
        method: "BRACKETS",
        brackets: [
          { upToMonthly: "758", percent: "0" },
          { upToMonthly: null, percent: "15" },
        ],
      },
      componentCode: "NI_ER",
      enabledByDefault: true,
      note: "Class 1 NI employer contributions 2026/27 (simplified): 0% below secondary threshold £758/mo, 15% above.",
    },
    {
      key: "PENSION_AE_EMP",
      label: "Workplace Pension (Employee Auto-Enrolment)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "5", wageFloorMonthly: "520" },
      componentCode: "PENSION_AE_EMP",
      enabledByDefault: false,
      note: "Minimum 5% employee contribution on qualifying earnings above £520/mo. Employer must auto-enrol eligible workers.",
    },
    {
      key: "PENSION_AE_ER",
      label: "Workplace Pension (Employer Auto-Enrolment)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "3", wageFloorMonthly: "520" },
      componentCode: "PENSION_AE_ER",
      enabledByDefault: false,
      note: "Minimum 3% employer contribution on qualifying earnings above £520/mo.",
    },
  ],
  complianceChecklist: [
    { key: "hmrc_paye_registration", label: "Register as an employer with HMRC", detail: "Register at least 4 weeks before first payment to set up PAYE scheme." },
    { key: "p45_p46_collection", label: "Collect P45 or starter checklist from new starters", detail: "Required to determine correct tax code before first payslip." },
    { key: "fps_submission", label: "Submit Full Payment Submission (FPS) on or before pay day", detail: "Real-time reporting to HMRC via RTI — mandatory for every payroll run." },
    { key: "paye_ni_payment", label: "Pay PAYE/NI to HMRC monthly or quarterly", detail: "Amounts due by 22nd of each month (19th for postal payment) for the prior tax month." },
    { key: "p60_annual", label: "Issue P60 to employees by 31 May", detail: "Annual certificate of earnings and tax deducted for the tax year ending 5 April." },
    { key: "p45_leavers", label: "Issue P45 to leavers on last day", detail: "P45 to be given to employee and submitted to HMRC on cessation of employment." },
    { key: "auto_enrolment", label: "Auto-enrol eligible workers in workplace pension", detail: "Assess workforce on staging date. Enrol eligible workers and maintain contributions." },
  ],
};

const AE_PACK: StatutoryPack = {
  country: "AE",
  countryName: "United Arab Emirates",
  currency: "AED",
  taxRegimeApplicable: false,
  items: [
    {
      key: "GPSSA_EMP",
      label: "GPSSA Pension (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "5" },
      componentCode: "GPSSA_EMP",
      enabledByDefault: false,
      note: "GCC nationals only. General Pension and Social Security Authority contributions 5% employee.",
    },
    {
      key: "GPSSA_ER",
      label: "GPSSA Pension (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "12.5" },
      componentCode: "GPSSA_ER",
      enabledByDefault: false,
      note: "GCC nationals only. Employer GPSSA contribution 12.5%. Expatriate employees are not covered.",
    },
  ],
  complianceChecklist: [
    { key: "mohre_registration", label: "Register with MOHRE (Ministry of Human Resources and Emiratisation)", detail: "All employers must register before hiring and maintain valid labor licenses." },
    { key: "wps_enrollment", label: "Enroll in the Wage Protection System (WPS)", detail: "Mandatory electronic wage payment system — process salaries through WPS to remain compliant." },
    { key: "wps_payroll_account", label: "Open a dedicated UAE payroll bank account", detail: "Required for WPS compliance. Salaries must be paid through a WPS-registered financial institution." },
    { key: "gratuity_accrual", label: "Accrue end-of-service gratuity", detail: "21 days basic pay per year for first 5 years, then 30 days/year. Track monthly accrual." },
    { key: "gpssa_nationals", label: "Register GCC nationals with GPSSA", detail: "Applicable only for UAE and other GCC national employees. 5% employee + 12.5% employer contributions." },
    { key: "payslip_records", label: "Maintain payslip records per UAE Labour Law", detail: "Employees must receive a payslip confirming wages, allowances, and deductions each pay cycle." },
    { key: "visa_compliance", label: "Ensure employment visa and labour card are valid", detail: "Employee must hold a valid UAE work visa and Emirates ID linked to the employer's establishment." },
  ],
};

const SG_PACK: StatutoryPack = {
  country: "SG",
  countryName: "Singapore",
  currency: "SGD",
  taxRegimeApplicable: false,
  items: [
    {
      key: "CPF_EMP",
      label: "CPF (Employee)",
      kind: "EMPLOYEE_DEDUCTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "20", wageCeilingMonthly: "7400.00" },
      componentCode: "CPF_EMP",
      enabledByDefault: true,
      note: "Ordinary Wage (OW) ceiling S$7,400/mo for 2026. Rate 20% applies to employees aged ≤55; age-banded rates apply above 55 — configure per employee age band.",
    },
    {
      key: "CPF_ER",
      label: "CPF (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "17", wageCeilingMonthly: "7400.00" },
      componentCode: "CPF_ER",
      enabledByDefault: true,
      note: "Employer CPF contribution rate 17% for employees aged ≤55. Age-banded rates apply above 55.",
    },
  ],
  complianceChecklist: [
    { key: "cpf_registration", label: "Register for CPF contributions with CPF Board", detail: "Register as an employer at CPF e-services before hiring first Singapore citizen or PR." },
    { key: "cpf_submission_deadline", label: "Submit CPF contributions by 14th (e-payment) or 19th (GIRO)", detail: "Monthly CPF contribution due on the 14th for electronic payment, 19th via GIRO." },
    { key: "ir8a_annual", label: "File IR8A by 1 March (annual remuneration statement)", detail: "Submit to IRAS: employee's earnings, CPF, and benefits for the preceding calendar year." },
    { key: "sdl_levy", label: "Skills Development Levy (SDL) — 0.25% of gross wages", detail: "Payable to CPF Board for all employees; contribution cap S$11.25/month per employee." },
    { key: "stp_reporting", label: "Single Touch Payroll (STP) via IRAS AIS", detail: "Auto-inclusion scheme: employer submits employee earnings to IRAS directly each calendar year." },
    { key: "itemized_payslips", label: "Provide itemized payslips under Employment Act", detail: "Itemized payslips required within 3 working days of payment for each payroll run." },
  ],
};

const AU_PACK: StatutoryPack = {
  country: "AU",
  countryName: "Australia",
  currency: "AUD",
  taxRegimeApplicable: false,
  items: [
    {
      key: "PAYG",
      label: "PAYG Withholding (Income Tax)",
      kind: "WITHHOLDING",
      calc: {
        method: "BRACKETS",
        brackets: [
          { upToMonthly: "1041.67", percent: "0" },
          { upToMonthly: "2916.67", percent: "19" },
          { upToMonthly: "7500.00", percent: "32.5" },
          { upToMonthly: null, percent: "37" },
        ],
      },
      componentCode: "PAYG",
      enabledByDefault: true,
      note: "Simplified 2025-26 resident PAYG brackets. Use ATO Tax Withheld Calculator for full precision.",
    },
    {
      key: "SUPER_ER",
      label: "Superannuation Guarantee (Employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      calc: { method: "PERCENT_OF_GROSS", percent: "12" },
      componentCode: "SUPER_ER",
      enabledByDefault: true,
      note: "Superannuation Guarantee rate 12% for 2025-26 (increased from 11.5%). Payable to employee's chosen super fund.",
    },
  ],
  complianceChecklist: [
    { key: "payg_withholding_registration", label: "Register for PAYG Withholding with ATO", detail: "Register via ABN portal before making first payroll payment." },
    { key: "super_fund_selection", label: "Offer employees choice of superannuation fund", detail: "Employees must be given a Standard Choice Form within 28 days of starting employment." },
    { key: "tfn_declaration", label: "Collect Tax File Number (TFN) declaration from new employees", detail: "If TFN not provided, withhold tax at highest marginal rate." },
    { key: "bas_payg_lodgement", label: "Lodge Business Activity Statement (BAS) for PAYG", detail: "Monthly or quarterly BAS lodgement with PAYG amounts withheld." },
    { key: "super_quarterly_payment", label: "Pay super contributions quarterly", detail: "Due by 28th day after each quarter end (28 Jan, 28 Apr, 28 Jul, 28 Oct)." },
    { key: "stp_phase2", label: "Single Touch Payroll Phase 2 reporting each pay run", detail: "STP Phase 2 is mandatory — report earnings, tax, and super details to ATO each payroll run." },
  ],
};

const GENERIC_PACK: StatutoryPack = {
  country: "GENERIC",
  countryName: "Generic / Other",
  currency: "USD",
  taxRegimeApplicable: false,
  items: [
    {
      key: "WITHHOLDING",
      label: "Income Tax Withholding",
      kind: "WITHHOLDING",
      calc: { method: "PERCENT_OF_GROSS", percent: "12" },
      componentCode: "WITHHOLDING",
      enabledByDefault: false,
      note: "Configurable withholding rate. Set percent based on local income tax obligations.",
    },
  ],
  complianceChecklist: [
    { key: "employer_registration", label: "Register as an employer with national tax authority", detail: "Complete employer registration before running first payroll." },
    { key: "payroll_frequency", label: "Confirm payroll frequency is legally permissible", detail: "Verify local labor law minimum pay frequency requirements." },
    { key: "income_tax_withholding", label: "Set up income tax withholding per local law", detail: "Determine applicable withholding rates and filing schedules." },
    { key: "social_contributions", label: "Register for social insurance contributions if applicable", detail: "Confirm whether employer and employee social contribution schemes apply." },
    { key: "payslip_requirements", label: "Ensure payslip records meet local requirements", detail: "Issue compliant payslips to employees each pay period." },
    { key: "minimum_wage", label: "Confirm statutory minimum wage compliance", detail: "Verify all employee compensation meets or exceeds local minimum wage requirements." },
  ],
};

export const STATUTORY_PACKS: StatutoryPack[] = [
  IN_PACK,
  US_PACK,
  UK_PACK,
  AE_PACK,
  SG_PACK,
  AU_PACK,
  GENERIC_PACK,
];

export const COUNTRY_DEFAULT_CURRENCY: Record<string, string> = {
  IN: "INR",
  US: "USD",
  GB: "GBP",
  AE: "AED",
  SG: "SGD",
  AU: "AUD",
};

export function getStatutoryPack(country: string): StatutoryPack {
  return STATUTORY_PACKS.find((p) => p.country === country) ?? GENERIC_PACK;
}
