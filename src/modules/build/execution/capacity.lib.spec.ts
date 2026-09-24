import { computeCapacity, countWorkingDays } from "./capacity.lib";
import type { CapacityInput } from "./capacity.lib";

describe("countWorkingDays", () => {
  it("counts five working days for a standard Mon-Fri week", () => {
    expect(countWorkingDays("2026-09-14", "2026-09-18")).toBe(5);
  });

  it("counts zero days when end is before start", () => {
    expect(countWorkingDays("2026-09-18", "2026-09-14")).toBe(0);
  });

  it("counts one day for a single Monday", () => {
    expect(countWorkingDays("2026-09-14", "2026-09-14")).toBe(1);
  });

  it("counts zero days for a Saturday-Sunday span", () => {
    expect(countWorkingDays("2026-09-12", "2026-09-13")).toBe(0);
  });

  it("counts ten working days over two full calendar weeks", () => {
    expect(countWorkingDays("2026-09-14", "2026-09-25")).toBe(10);
  });

  it("counts working days correctly when window starts on a Saturday", () => {
    expect(countWorkingDays("2026-09-12", "2026-09-18")).toBe(5);
  });
});

const BASE: CapacityInput = {
  windowStart: "2026-09-14",
  windowEnd: "2026-09-18",
  expectedDailyHours: 8,
  loggedHours: 0,
  leaves: [],
};

describe("computeCapacity — no leave, no logged hours", () => {
  it("returns five working days for a Mon-Fri window with no leaves", () => {
    const r = computeCapacity(BASE);
    expect(r.workingDaysInWindow).toBe(5);
    expect(r.leaveDays).toBe(0);
    expect(r.halfLeaveDays).toBe(0);
    expect(r.netCapacityDays).toBe(5);
  });

  it("computes capacityHours as workingDays * expectedDailyHours", () => {
    const r = computeCapacity(BASE);
    expect(r.capacityHours).toBe(40);
  });

  it("is not over-allocated when no hours are logged", () => {
    const r = computeCapacity(BASE);
    expect(r.isOverAllocated).toBe(false);
  });

  it("utilizationPercent is zero when no hours are logged", () => {
    const r = computeCapacity(BASE);
    expect(r.utilizationPercent).toBe(0);
  });
});

describe("computeCapacity — full utilization", () => {
  it("shows 100% utilization when logged equals capacity", () => {
    const r = computeCapacity({ ...BASE, loggedHours: 40 });
    expect(r.utilizationPercent).toBe(100);
    expect(r.isOverAllocated).toBe(false);
  });

  it("marks over-allocated when logged exceeds capacity", () => {
    const r = computeCapacity({ ...BASE, loggedHours: 41 });
    expect(r.isOverAllocated).toBe(true);
  });

  it("is not over-allocated when logged equals capacity exactly", () => {
    const r = computeCapacity({ ...BASE, loggedHours: 40 });
    expect(r.isOverAllocated).toBe(false);
  });
});

describe("computeCapacity — full-day leave", () => {
  it("deducts a full working-day leave from capacity", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-14", endDate: "2026-09-14", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(1);
    expect(r.netCapacityDays).toBe(4);
    expect(r.capacityHours).toBe(32);
  });

  it("deducts a full-week leave leaving zero capacity", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-14", endDate: "2026-09-18", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(5);
    expect(r.netCapacityDays).toBe(0);
    expect(r.capacityHours).toBe(0);
    expect(r.isZeroCapacity).toBe(true);
  });

  it("does not deduct a leave that falls entirely outside the window", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-07", endDate: "2026-09-11", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(0);
    expect(r.capacityHours).toBe(40);
  });

  it("clips a leave that starts before the window to the window start", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-10", endDate: "2026-09-14", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(1);
    expect(r.capacityHours).toBe(32);
  });

  it("clips a leave that ends after the window to the window end", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-18", endDate: "2026-09-22", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(1);
    expect(r.capacityHours).toBe(32);
  });
});

describe("computeCapacity — half-day leave", () => {
  it("deducts 0.5 days for a half-day leave on a working day", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-14", endDate: "2026-09-14", isHalfDay: true }],
    });
    expect(r.halfLeaveDays).toBe(1);
    expect(r.netCapacityDays).toBe(4.5);
    expect(r.capacityHours).toBe(36);
  });

  it("combines a full-day and a half-day leave correctly", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [
        { startDate: "2026-09-14", endDate: "2026-09-14", isHalfDay: false },
        { startDate: "2026-09-15", endDate: "2026-09-15", isHalfDay: true },
      ],
    });
    expect(r.leaveDays).toBe(1);
    expect(r.halfLeaveDays).toBe(1);
    expect(r.netCapacityDays).toBe(3.5);
    expect(r.capacityHours).toBe(28);
  });
});

describe("computeCapacity — zero-capacity member", () => {
  it("marks over-allocated when capacity is zero and hours are logged", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-14", endDate: "2026-09-18", isHalfDay: false }],
      loggedHours: 1,
    });
    expect(r.isZeroCapacity).toBe(true);
    expect(r.isOverAllocated).toBe(true);
  });

  it("is not over-allocated when capacity is zero and no hours are logged", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-14", endDate: "2026-09-18", isHalfDay: false }],
      loggedHours: 0,
    });
    expect(r.isZeroCapacity).toBe(true);
    expect(r.isOverAllocated).toBe(false);
  });

  it("returns null utilizationPercent when capacity is zero to avoid division by zero", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-14", endDate: "2026-09-18", isHalfDay: false }],
      loggedHours: 4,
    });
    expect(r.utilizationPercent).toBeNull();
  });
});

describe("computeCapacity — no expectedDailyHours (ticket-count fallback mode)", () => {
  it("returns null capacityHours when expectedDailyHours is null", () => {
    const r = computeCapacity({ ...BASE, expectedDailyHours: null });
    expect(r.capacityHours).toBeNull();
  });

  it("does not mark over-allocated when expectedDailyHours is null even with large loggedHours", () => {
    const r = computeCapacity({ ...BASE, expectedDailyHours: null, loggedHours: 999 });
    expect(r.isOverAllocated).toBe(false);
  });

  it("returns null utilizationPercent when expectedDailyHours is null", () => {
    const r = computeCapacity({ ...BASE, expectedDailyHours: null, loggedHours: 40 });
    expect(r.utilizationPercent).toBeNull();
  });

  it("returns false isZeroCapacity when expectedDailyHours is null", () => {
    const r = computeCapacity({ ...BASE, expectedDailyHours: null });
    expect(r.isZeroCapacity).toBe(false);
  });
});

describe("computeCapacity — empty window", () => {
  it("returns zero workingDaysInWindow when start equals end and falls on a weekend", () => {
    const r = computeCapacity({
      ...BASE,
      windowStart: "2026-09-12",
      windowEnd: "2026-09-13",
    });
    expect(r.workingDaysInWindow).toBe(0);
    expect(r.capacityHours).toBe(0);
    expect(r.isZeroCapacity).toBe(true);
  });
});

describe("computeCapacity — leave on a weekend is not deducted", () => {
  it("does not deduct a leave that spans only weekend days from capacity", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-12", endDate: "2026-09-13", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(0);
    expect(r.capacityHours).toBe(40);
  });

  it("deducts only the Monday portion when a leave spans a weekend into Monday", () => {
    const r = computeCapacity({
      ...BASE,
      leaves: [{ startDate: "2026-09-12", endDate: "2026-09-14", isHalfDay: false }],
    });
    expect(r.leaveDays).toBe(1);
    expect(r.capacityHours).toBe(32);
  });
});
