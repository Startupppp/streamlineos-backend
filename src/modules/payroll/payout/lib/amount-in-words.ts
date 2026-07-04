const A = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const B = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function helper(n: number): string {
  if (n < 20) return A[n] ?? "";
  if (n < 100) return (B[Math.floor(n / 10)] ?? "") + (n % 10 ? " " + (A[n % 10] ?? "") : "");
  if (n < 1000) return (A[Math.floor(n / 100)] ?? "") + " Hundred" + (n % 100 ? " " + helper(n % 100) : "");
  if (n < 100_000) return helper(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + helper(n % 1000) : "");
  if (n < 10_000_000) return helper(Math.floor(n / 100_000)) + " Lakh" + (n % 100_000 ? " " + helper(n % 100_000) : "");
  return helper(Math.floor(n / 10_000_000)) + " Crore" + (n % 10_000_000 ? " " + helper(n % 10_000_000) : "");
}

export function amountInWords(decimalString: string, currency: string): string {
  const n = Math.max(0, Math.floor(parseFloat(decimalString) || 0));
  if (n === 0) return currency === "INR" ? "Zero Rupees Only" : "Zero Only";
  const words = helper(n);
  return currency === "INR" ? `${words} Rupees Only` : `${words} Only`;
}
