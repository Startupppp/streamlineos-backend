import { CACHE_KEYS } from "../../common/cache/cache-keys";

describe("inventory list cache namespaces", () => {
  const families = [
    CACHE_KEYS.invProductsNamespace,
    CACHE_KEYS.invPoNamespace,
    CACHE_KEYS.invGrnNamespace,
    CACHE_KEYS.invSoNamespace,
  ];

  it.each(families)("is tenant-scoped and contains no wildcard", (namespace) => {
    expect(namespace("org-a")).not.toBe(namespace("org-b"));
    expect(namespace("org-a")).toContain("org-a");
    expect(namespace("org-a")).not.toContain("*");
  });
});
