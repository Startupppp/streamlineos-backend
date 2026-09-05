import { NoopAvScanner } from "./av-scan";

describe("NoopAvScanner", () => {
  it("always returns clean in non-production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const scanner = new NoopAvScanner();
    const result = await scanner.scan(Buffer.from("hello"), "file.txt", "text/plain");
    expect(result).toEqual({ status: "clean" });
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("fails closed in production when no AV provider is configured", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const scanner = new NoopAvScanner();
    const result = await scanner.scan(Buffer.from("hello"), "file.txt", "text/plain");
    expect(result).toEqual({ status: "error", reason: "malware-scanning-disabled" });
    process.env.NODE_ENV = previousNodeEnv;
  });
});

