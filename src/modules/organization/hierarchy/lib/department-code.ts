export function toDepartmentCode(name: string): string {
  const alnum = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  if (alnum.length >= 2) return alnum;
  return (alnum || "DEPT").padEnd(2, "X");
}

export function nextDepartmentCode(base: string, suffix: number): string {
  const suffixStr = String(suffix);
  return `${base.slice(0, 20 - suffixStr.length)}${suffixStr}`;
}
