export const PROMPT_NOTES_MAX = 2000;

export function trunc(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > PROMPT_NOTES_MAX ? s.slice(0, PROMPT_NOTES_MAX) + "…" : s;
}
