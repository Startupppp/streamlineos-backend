import { nextPeriodEnd } from "./period-anniversary";

describe("nextPeriodEnd — monthly cycle clamping", () => {
  it("advances a January 31 anchor to the last day of February (non-leap)", () => {
    const start = new Date(2026, 0, 31);
    const result = nextPeriodEnd(start, "monthly");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });

  it("advances a January 31 anchor to February 29 in a leap year", () => {
    const start = new Date(2028, 0, 31);
    const result = nextPeriodEnd(start, "monthly");
    expect(result.getFullYear()).toBe(2028);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(29);
  });

  it("advances a March 31 anchor to April 30", () => {
    const start = new Date(2026, 2, 31);
    const result = nextPeriodEnd(start, "monthly");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(3);
    expect(result.getDate()).toBe(30);
  });

  it("advances a December 31 anchor to January 31 of the next year", () => {
    const start = new Date(2026, 11, 31);
    const result = nextPeriodEnd(start, "monthly");
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(31);
  });

  it("does not clamp when the target month has the same number of days as the source", () => {
    const start = new Date(2026, 0, 28);
    const result = nextPeriodEnd(start, "monthly");
    expect(result.getDate()).toBe(28);
  });

  it("preserves the time-of-day component of the start date", () => {
    const start = new Date(2026, 0, 15, 14, 30, 45, 123);
    const result = nextPeriodEnd(start, "monthly");
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(45);
    expect(result.getMilliseconds()).toBe(123);
  });
});

describe("nextPeriodEnd — annual cycle clamping", () => {
  it("advances a February 29 leap-year anchor to February 28 in the following non-leap year", () => {
    const start = new Date(2028, 1, 29);
    const result = nextPeriodEnd(start, "annual");
    expect(result.getFullYear()).toBe(2029);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });

  it("advances a January 31 anchor by exactly twelve months", () => {
    const start = new Date(2026, 0, 31);
    const result = nextPeriodEnd(start, "annual");
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(31);
  });

  it("an annual subscription started 2026-03-15 expires 2027-03-15", () => {
    const start = new Date(2026, 2, 15);
    const result = nextPeriodEnd(start, "annual");
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(15);
  });

  it("does not expire an annual subscription after one month", () => {
    const start = new Date(2026, 0, 15);
    const oneMonthLater = new Date(2026, 1, 15);
    const result = nextPeriodEnd(start, "annual");
    expect(result.getTime()).toBeGreaterThan(oneMonthLater.getTime());
  });
});
