import {
  isForeignOrgKey,
  isSensitiveStorageKey,
  parseStorageKey,
} from "./storage-key";

/**
 * `StoragePlacement.objectKey` mints `<keyPrefix>/<orgId>/<folder>/<uuid>-<name>`
 * whenever a region sets `R2_KEY_PREFIX` (`region.config.ts` reads
 * `<REGION>_R2_KEY_PREFIX`, falling back to a flat `R2_KEY_PREFIX`), and
 * `<orgId>/<folder>/…` when it does not.
 *
 * `parseStorageKey` used to read the organisation from segment one only, so under
 * any prefixed region it reported `ownerOrgId: null` and the PREFIX as the folder
 * root. Both guards built on it then degraded to "allow" at once:
 *
 *   - `isForeignOrgKey` returned false for another tenant's key, and
 *   - the folder root was "eu" rather than "documents", so it is not in
 *     SENSITIVE_FOLDER_ROOTS and `StorageController.assertKeyReadable`'s
 *     unresolved-sensitive-key denial did not fire either.
 *
 * The result was a signed download URL for a foreign tenant's HR document. The
 * hole is config-conditional — invisible on an unprefixed deployment — which is
 * exactly why it needs a spec rather than a deployment check.
 */
describe("parseStorageKey — region key prefix", () => {
  const CALLER = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";

  describe("unprefixed region (keyPrefix unset)", () => {
    it("reads the owner and folder off the caller's own key", () => {
      expect(parseStorageKey(`${CALLER}/documents/a-file.pdf`, CALLER)).toEqual({
        ownerOrgId: CALLER,
        folderRoot: "documents",
      });
    });

    it("refuses another tenant's key and still sees the folder as sensitive", () => {
      const key = `${OTHER}/documents/a-file.pdf`;
      expect(isForeignOrgKey(key, CALLER)).toBe(true);
      expect(isSensitiveStorageKey(key, CALLER)).toBe(true);
    });
  });

  describe("prefixed region (R2_KEY_PREFIX set)", () => {
    it("reads the owner from segment two and the folder from segment three", () => {
      expect(parseStorageKey(`eu/${CALLER}/documents/a-file.pdf`, CALLER)).toEqual({
        ownerOrgId: CALLER,
        folderRoot: "documents",
      });
    });

    it("refuses another tenant's key — the foreign-org guard must not degrade", () => {
      expect(isForeignOrgKey(`eu/${OTHER}/documents/a-file.pdf`, CALLER)).toBe(true);
    });

    it("still classifies the folder as sensitive — the fallback denial must not degrade", () => {
      expect(isSensitiveStorageKey(`eu/${OTHER}/documents/a-file.pdf`, CALLER)).toBe(true);
      expect(isSensitiveStorageKey(`eu/${CALLER}/payslips/a-file.pdf`, CALLER)).toBe(true);
    });

    it("keeps the org-namespaced folders readable when they sit behind a prefix", () => {
      expect(parseStorageKey(`eu/kb-media/${OTHER}/img.png`, CALLER)).toEqual({
        ownerOrgId: OTHER,
        folderRoot: "kb-media",
      });
      expect(isForeignOrgKey(`eu/kb-media/${OTHER}/img.png`, CALLER)).toBe(true);
    });
  });

  describe("legacy keys stay legacy", () => {
    /**
     * The prefixed branch keys off segment two being an organisation id, so a
     * legacy `<folder>/<uuid>-<name>` key must not be misread as prefixed: its
     * segment two is a FILE name that merely begins with a uuid, and
     * UUID_PATTERN is anchored, so it cannot match.
     */
    it("does not mistake a uuid-prefixed FILE name for an organisation", () => {
      const key = `uploads/${OTHER}-report.pdf`;
      expect(parseStorageKey(key, CALLER)).toEqual({
        ownerOrgId: null,
        folderRoot: "uploads",
      });
      expect(isForeignOrgKey(key, CALLER)).toBe(false);
    });

    it("leaves a two-segment legacy key unowned", () => {
      expect(parseStorageKey("documents/a-file.pdf", CALLER)).toEqual({
        ownerOrgId: null,
        folderRoot: "documents",
      });
      // Unowned but still sensitive: assertKeyReadable denies an unresolved key
      // whose folder root is sensitive, which is the compensating control for
      // the legacy shape until the ticket-34 backfill removes it.
      expect(isSensitiveStorageKey("documents/a-file.pdf", CALLER)).toBe(true);
    });

    it("leaves a single-segment key unowned", () => {
      expect(parseStorageKey("a-file.pdf", CALLER)).toEqual({
        ownerOrgId: null,
        folderRoot: "a-file.pdf",
      });
    });
  });
});
