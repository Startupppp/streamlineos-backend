export function formatDateOnly(value: Date | string | null | undefined): string {
  if (!value) return "";
  let date = value;
  if (typeof date === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    date = new Date(date);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractVariables(htmlContent: string): string[] {
  const tokenRegex = /\{\{([^}]+)\}\}/g;
  const vars: string[] = [];
  let match: RegExpExecArray | null = tokenRegex.exec(htmlContent);
  while (match !== null) {
    const trimmed = match[1].trim();
    if (!vars.includes(trimmed)) vars.push(trimmed);
    match = tokenRegex.exec(htmlContent);
  }
  return vars;
}
