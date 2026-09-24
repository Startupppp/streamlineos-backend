export const ANONYMITY_MIN_RESPONSES = 5;

export function isBelowAnonymityThreshold(responses: number): boolean {
  return responses < ANONYMITY_MIN_RESPONSES;
}
