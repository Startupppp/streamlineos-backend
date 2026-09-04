/**
 * Text limits shared by every ticket AI path. A prompt built from a ticket body
 * and one built from an unsaved draft have to truncate identically, or the same
 * text produces two different prompts depending on which route it arrived by.
 */

export const TEXT_LIMIT = 2000;

export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
