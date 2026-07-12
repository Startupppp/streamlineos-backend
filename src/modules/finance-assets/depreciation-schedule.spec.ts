type ScheduleRow = { periodKey: string; amount: string };

function buildStraightLineSchedule(
  acquisitionDate: string,
  acquisitionCost: number,
  salvageValue: number,
  usefulLifeMonths: number,
): ScheduleRow[] {
  const depreciable = acquisitionCost - salvageValue;
  if (depreciable <= 0 || usefulLifeMonths <= 0) return [];

  const monthly = Math.floor((depreciable / usefulLifeMonths) * 10000) / 10000;
  const rows: ScheduleRow[] = [];
  const parts = acquisitionDate.split("-").map(Number);
  const startYear = parts[0] ?? 2000;
  const startMonth = parts[1] ?? 1;

  let totalAllocated = 0;
  for (let i = 0; i < usefulLifeMonths; i++) {
    const m = ((startMonth - 1 + i) % 12) + 1;
    const y = startYear + Math.floor((startMonth - 1 + i) / 12);
    const periodKey = `${y}-${String(m).padStart(2, "0")}`;
    const isLast = i === usefulLifeMonths - 1;
    const amount = isLast
      ? String(Math.round((depreciable - totalAllocated) * 10000) / 10000)
      : String(monthly);
    totalAllocated += monthly;
    rows.push({ periodKey, amount });
  }
  return rows;
}

describe("buildStraightLineSchedule", () => {
  describe("basic schedule properties", () => {
    it("produces exactly usefulLifeMonths rows", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 12000, 0, 12);
      expect(rows).toHaveLength(12);
    });

    it("total of all amounts equals depreciable amount (1000, 12mo)", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000, 0, 12);
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      expect(Math.round(total * 10000) / 10000).toBe(1000);
    });

    it("salvage is excluded from depreciable base", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000, 200, 12);
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      expect(Math.round(total * 10000) / 10000).toBe(800);
    });

    it("truncates monthly amount to 4dp (floor)", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000, 0, 3);
      expect(rows[0]!.amount).toBe("333.3333");
    });

    it("last period absorbs rounding remainder so total ties exactly", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000, 0, 3);
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      expect(Math.round(total * 10000) / 10000).toBe(1000);
    });
  });

  describe("1-month life", () => {
    it("produces one row with full depreciable amount", () => {
      const rows = buildStraightLineSchedule("2024-06-01", 5000, 500, 1);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.amount)).toBe(4500);
    });

    it("periodKey matches acquisition month", () => {
      const rows = buildStraightLineSchedule("2024-06-01", 5000, 500, 1);
      expect(rows[0]!.periodKey).toBe("2024-06");
    });
  });

  describe("60-month life", () => {
    it("produces 60 rows", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 60000, 0, 60);
      expect(rows).toHaveLength(60);
    });

    it("total ties exactly to cost", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 60000, 0, 60);
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      expect(Math.round(total * 10000) / 10000).toBe(60000);
    });

    it("spans correct year range (2024-01 through 2028-12)", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 60000, 0, 60);
      expect(rows[0]!.periodKey).toBe("2024-01");
      expect(rows[59]!.periodKey).toBe("2028-12");
    });
  });

  describe("rounding-remainder edge: cost=1000.01, 3 months", () => {
    it("produces 3 rows", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000.01, 0, 3);
      expect(rows).toHaveLength(3);
    });

    it("first two rows have truncated monthly amount", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000.01, 0, 3);
      expect(rows[0]!.amount).toBe("333.3366");
      expect(rows[1]!.amount).toBe("333.3366");
    });

    it("total ties exactly to 1000.01", () => {
      const rows = buildStraightLineSchedule("2024-01-01", 1000.01, 0, 3);
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      expect(Math.round(total * 10000) / 10000).toBe(1000.01);
    });
  });

  describe("zero / negative depreciable amount", () => {
    it("returns empty array when cost equals salvage", () => {
      expect(buildStraightLineSchedule("2024-01-01", 1000, 1000, 12)).toHaveLength(0);
    });

    it("returns empty array when useful life is zero", () => {
      expect(buildStraightLineSchedule("2024-01-01", 1000, 0, 0)).toHaveLength(0);
    });
  });

  describe("period key rollover across year boundary", () => {
    it("correctly rolls over December to January next year", () => {
      const rows = buildStraightLineSchedule("2024-11-01", 2400, 0, 3);
      expect(rows[0]!.periodKey).toBe("2024-11");
      expect(rows[1]!.periodKey).toBe("2024-12");
      expect(rows[2]!.periodKey).toBe("2025-01");
    });
  });
});
