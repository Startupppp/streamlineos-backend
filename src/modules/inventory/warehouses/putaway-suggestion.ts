/**
 * The shape a putaway suggestion has before anything ranks it.
 *
 * This lives in its own leaf module rather than beside the service that builds
 * it because NEO-6 made the slotting rules rank these, and slotting cannot
 * import the putaway service without the two files importing each other. The
 * type is the only thing they genuinely share, so it is the thing that moves;
 * `check:cycles` is a CI gate and a type-only cycle fails it exactly as a
 * runtime one would.
 */
export interface PutawaySuggestion {
  locationId: number;
  code: string;
  name: string;
  /** null when the location records no capacity, which means unlimited. */
  capacity: string | null;
  onHand: string;
  remaining: string | null;
  /** Whether this location already holds the variant being put away. */
  holdsVariant: boolean;
  fits: boolean;
}
