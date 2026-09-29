import { ConflictException, NotFoundException } from "@nestjs/common";
import { assertRestorable, clearingLifecycle } from "./lifecycle-restore";

function uniqueViolation(): Error {
  const err = new Error("duplicate key value violates unique constraint");
  Object.assign(err, { code: "23505" });
  return err;
}

describe("build lifecycle restore guards", () => {
  it("assertRestorable answers 404 when the row does not exist", () => {
    expect(() => assertRestorable(undefined, "Release")).toThrow(NotFoundException);
  });

  it("assertRestorable answers 409 when the row is live, so restore is never a no-op that reports success", () => {
    expect(() => assertRestorable({ deletedAt: null }, "Release")).toThrow(
      new ConflictException("Release is not deleted"),
    );
  });

  it("assertRestorable passes a deleted row through", () => {
    expect(() => assertRestorable({ deletedAt: new Date() }, "Release")).not.toThrow();
  });

  it("clearingLifecycle turns a unique violation into a 409 naming the occupied slot", async () => {
    await expect(
      clearingLifecycle("Release", () => Promise.reject(uniqueViolation())),
    ).rejects.toThrow(ConflictException);
    await expect(
      clearingLifecycle("Release", () => Promise.reject(uniqueViolation())),
    ).rejects.toThrow(/already holds one of its unique keys/);
  });

  it("clearingLifecycle recognises a unique violation wrapped by drizzle in `cause`", async () => {
    const wrapped = new Error("Failed query");
    Object.assign(wrapped, { cause: uniqueViolation() });
    await expect(
      clearingLifecycle("Release", () => Promise.reject(wrapped)),
    ).rejects.toThrow(ConflictException);
  });

  it("clearingLifecycle rethrows anything that is not a unique violation untouched", async () => {
    const boom = new Error("connection reset");
    await expect(clearingLifecycle("Release", () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("clearingLifecycle returns the write result on success", async () => {
    await expect(clearingLifecycle("Release", () => Promise.resolve([{ id: 1 }]))).resolves.toEqual([
      { id: 1 },
    ]);
  });
});
