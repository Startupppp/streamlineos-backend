import { isPlatformOperator, PLATFORM_OPERATORS } from "./platform-operator.guard";

describe("isPlatformOperator", () => {
  it("recognises an operator", () => {
    expect(isPlatformOperator(PLATFORM_OPERATORS[0])).toBe(true);
  });

  it("ignores case and surrounding whitespace, which a mail client adds", () => {
    const operator = PLATFORM_OPERATORS[0] as string;

    expect(isPlatformOperator(`  ${operator.toUpperCase()}  `)).toBe(true);
  });

  /**
   * The whole point of the guard.
   *
   * An organisation's own admin is not a platform operator. If this were an RBAC
   * key instead, any tenant admin could grant themselves the right to create
   * other people's organisations.
   */
  it("refuses somebody who merely administers a tenant", () => {
    expect(isPlatformOperator("admin@somecustomer.example")).toBe(false);
  });

  it("refuses a missing email rather than treating absence as permission", () => {
    expect(isPlatformOperator(undefined)).toBe(false);
    expect(isPlatformOperator(null)).toBe(false);
    expect(isPlatformOperator("")).toBe(false);
  });

  /**
   * A near-miss that a `includes`-style check would have let through.
   */
  it("refuses an address that merely contains an operator's", () => {
    const operator = PLATFORM_OPERATORS[0] as string;

    expect(isPlatformOperator(`${operator}.attacker.example`)).toBe(false);
    expect(isPlatformOperator(`x${operator}`)).toBe(false);
  });
});
