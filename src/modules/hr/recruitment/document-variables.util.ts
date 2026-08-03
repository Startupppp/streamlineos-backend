import { escapeHtml, sanitizeHtml } from "../templates/html-sanitizer";

const TOKEN_REGEX = /\{\{([^}]+)\}\}/g;

export function substituteVariables(
  htmlContent: string,
  variables: Record<string, string>,
): { result: string; missing: string[] } {
  const missing: string[] = [];
  const result = htmlContent.replace(TOKEN_REGEX, (match, key: string) => {
    const trimmed = key.trim();
    const val = variables[trimmed];
    if (!val) {
      missing.push(trimmed);
      return match;
    }
    return escapeHtml(val);
  });
  return { result: sanitizeHtml(result), missing };
}
