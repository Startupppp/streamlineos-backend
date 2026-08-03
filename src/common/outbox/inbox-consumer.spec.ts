import { shouldProcessVersion } from "./inbox-consumer";

describe("shouldProcessVersion", () => {
  it("processes an event when the aggregate has never been applied", () => {
    expect(shouldProcessVersion(null, 1)).toBe(true);
  });

  it("processes an event whose version is newer than the last applied", () => {
    expect(shouldProcessVersion(1, 2)).toBe(true);
  });

  it("skips an event whose version was already applied", () => {
    expect(shouldProcessVersion(2, 2)).toBe(false);
  });

  it("skips a stale event that arrived out of order after a newer one", () => {
    expect(shouldProcessVersion(3, 2)).toBe(false);
  });
});
