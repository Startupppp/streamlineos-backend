const A = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const B = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function helperIN(n: number): string {
  if (n < 20) return A[n] ?? "";
  if (n < 100) return (B[Math.floor(n / 10)] ?? "") + (n % 10 ? " " + (A[n % 10] ?? "") : "");
  if (n < 1000) return (A[Math.floor(n / 100)] ?? "") + " Hundred" + (n % 100 ? " " + helperIN(n % 100) : "");
  if (n < 100_000) return helperIN(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + helperIN(n % 1000) : "");
  if (n < 10_000_000) return helperIN(Math.floor(n / 100_000)) + " Lakh" + (n % 100_000 ? " " + helperIN(n % 100_000) : "");
  return helperIN(Math.floor(n / 10_000_000)) + " Crore" + (n % 10_000_000 ? " " + helperIN(n % 10_000_000) : "");
}

function helperIntl(n: number): string {
  if (n < 20) return A[n] ?? "";
  if (n < 100) return (B[Math.floor(n / 10)] ?? "") + (n % 10 ? " " + (A[n % 10] ?? "") : "");
  if (n < 1_000) return (A[Math.floor(n / 100)] ?? "") + " Hundred" + (n % 100 ? " " + helperIntl(n % 100) : "");
  if (n < 1_000_000) return helperIntl(Math.floor(n / 1_000)) + " Thousand" + (n % 1_000 ? " " + helperIntl(n % 1_000) : "");
  if (n < 1_000_000_000) return helperIntl(Math.floor(n / 1_000_000)) + " Million" + (n % 1_000_000 ? " " + helperIntl(n % 1_000_000) : "");
  return helperIntl(Math.floor(n / 1_000_000_000)) + " Billion" + (n % 1_000_000_000 ? " " + helperIntl(n % 1_000_000_000) : "");
}

interface CurrencyConfig {
  major: string;
  minor: string;
  minorPerMajor: number;
  intl: boolean;
}

const CURRENCY_CONFIG: Record<string, CurrencyConfig> = {
  INR: { major: "Rupees", minor: "", minorPerMajor: 0, intl: false },
  USD: { major: "Dollars", minor: "Cents", minorPerMajor: 100, intl: true },
  GBP: { major: "Pounds", minor: "Pence", minorPerMajor: 100, intl: true },
  EUR: { major: "Euros", minor: "Cents", minorPerMajor: 100, intl: true },
  AED: { major: "Dirhams", minor: "Fils", minorPerMajor: 100, intl: true },
  SGD: { major: "Dollars", minor: "Cents", minorPerMajor: 100, intl: true },
  AUD: { major: "Dollars", minor: "Cents", minorPerMajor: 100, intl: true },
  JPY: { major: "Yen", minor: "", minorPerMajor: 0, intl: true },
};

export function amountInWords(decimalString: string, currency: string): string {
  const raw = parseFloat(decimalString) || 0;
  const value = Math.max(0, raw);
  const whole = Math.floor(value);
  const config = CURRENCY_CONFIG[currency];

  if (!config) {
    if (whole === 0) return `Zero ${currency} Only`;
    return `${helperIntl(whole)} ${currency} Only`;
  }

  const wordsOf = config.intl ? helperIntl : helperIN;

  if (config.minorPerMajor === 0) {
    if (whole === 0) return `Zero ${config.major} Only`;
    return `${wordsOf(whole)} ${config.major} Only`;
  }

  const minor = Math.round((value - whole) * config.minorPerMajor);
  const majorWords = whole > 0 ? `${wordsOf(whole)} ${config.major}` : null;
  const minorWords = minor > 0 ? `${helperIntl(minor)} ${config.minor}` : null;

  if (!majorWords && !minorWords) return `Zero ${config.major} Only`;
  if (majorWords && minorWords) return `${majorWords} and ${minorWords} Only`;
  if (majorWords) return `${majorWords} Only`;
  return `Zero ${config.major} and ${minorWords} Only`;
}
