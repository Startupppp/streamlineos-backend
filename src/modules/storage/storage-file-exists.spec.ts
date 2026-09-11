import { isMissingObjectError } from "./storage.service";

describe("isMissingObjectError", () => {
  it("recognizes provider not-found errors", () => {
    expect(isMissingObjectError(Object.assign(new Error("missing"), { name: "NotFound" }))).toBe(true);
    expect(isMissingObjectError(Object.assign(new Error("missing"), { name: "NoSuchKey" }))).toBe(true);
    expect(isMissingObjectError(Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }))).toBe(true);
  });

  it("does not classify provider failures as absence", () => {
    expect(isMissingObjectError(new Error("AccessDenied"))).toBe(false);
    expect(isMissingObjectError(Object.assign(new Error("failed"), { $metadata: { httpStatusCode: 503 } }))).toBe(false);
  });
});
