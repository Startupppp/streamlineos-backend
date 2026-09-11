import { publicUrlFor } from "./lib/storage-placement";

/**
 * The rule that decides whether an object gets a URL, which nothing tested.
 *
 * `publicUrlFor` is the only thing between an HR document and a publicly
 * fetchable link. Every upload path funnels through it, and for a folder in
 * `PRIVATE_HR_FOLDERS` it must hand back the bare key so the caller has to go
 * through `getFileUrl` and get a time-limited signed URL instead.
 *
 * It was uncovered. Deleting the `PRIVATE_HR_FOLDERS.has(folderRoot)` line
 * entirely — so `uploadFile("hr-documents", …)` returns
 * `https://<public base>/hr-documents/…` to every caller — left all eighteen
 * suites under `modules/storage` and `degradation` green. The neighbouring
 * `isValidFileKey` is covered twice over (`storage.controller.spec.ts:378` and
 * `degradation/object-storage.spec.ts:110`), which is what made the gap easy to
 * miss: the file looked tested.
 *
 * Each case below fails under that deletion except the last two, which pin the
 * behaviour for everything else so the rule cannot be "fixed" by making every
 * folder private.
 */
describe("publicUrlFor — private folders never yield a public URL", () => {
  const PUBLIC_BASE = "https://files.example.com";

  it.each([
    "documents",
    "hr-documents",
    "onboarding",
    "onboarding-docs",
    "resignations",
    "hr-exports",
  ])("returns the bare key for %s, not a fetchable URL", (folder) => {
    const key = `${folder}/2026/contract.pdf`;
    expect(publicUrlFor(folder, key, PUBLIC_BASE)).toBe(key);
  });

  it("matches on the FIRST path segment, so nested private folders are covered", () => {
    const key = "hr-documents/org-1/emp-7/offer.pdf";
    expect(publicUrlFor("hr-documents/org-1/emp-7", key, PUBLIC_BASE)).toBe(key);
  });

  it("a private root is not escapable by an explicit public-url override", () => {
    const key = "resignations/letter.pdf";
    expect(publicUrlFor("resignations", key, undefined, "https://cdn.example.com")).toBe(key);
  });

  it("still returns a public URL for an ordinary folder", () => {
    const key = "uploads/logo.png";
    expect(publicUrlFor("uploads", key, PUBLIC_BASE)).toBe(`${PUBLIC_BASE}/${key}`);
  });

  it("falls back to the bare key when no public base is configured at all", () => {
    const key = "uploads/logo.png";
    expect(publicUrlFor("uploads", key, undefined)).toBe(key);
  });

  /**
   * `compressAndPreGenerateKey` calls this with three arguments, putting its
   * override in the `regionPublicUrl` slot. Pinned because it reads like a bug
   * and is not one — `override ?? regionPublicUrl` resolves to the same base.
   */
  it("treats a three-argument call as supplying the base", () => {
    const key = "uploads/a.png";
    expect(publicUrlFor("uploads", key, "https://cdn.example.com")).toBe(
      `https://cdn.example.com/${key}`,
    );
  });
});
