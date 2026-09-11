/**
 * Whether a PATCH's change set carries anything to write.
 *
 * Drizzle's `mapUpdateSet` drops every `undefined` and then throws `No values to set` on the empty
 * result, so an all-optional body that arrives empty leaves the handler as an unhandled 500 rather
 * than as the no-op it describes. Asking this first lets the route answer its object instead.
 */
export function hasPatchValues(values: Record<string, unknown>): boolean {
  return Object.values(values).some((value) => value !== undefined);
}
