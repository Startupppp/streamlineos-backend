import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { TaxComplianceService } from "./tax-compliance.service";

const DUE_WARNING_DAYS = 5;
const ORG = "org-due-window";
const WALK_START = Date.UTC(2027, 11, 1);
const WALK_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DayObservation {
  iso: string;
  dayOfMonth: number;
  reachedDb: boolean;
  gstr1DueDate?: string;
  gstr3bDueDate?: string;
  daysUntilGstr1?: number;
  daysUntilGstr3b?: number;
  period?: string;
}

function makeDb(): { db: Db; selectCount: () => number } {
  let calls = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      calls += 1;
      const rows =
        calls % 2 === 1
          ? [{ cgst: "600", sgst: "400", igst: "0" }]
          : [{ cgst: "0", sgst: "0", igst: "0" }];
      return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) };
    }),
  } as unknown as Db;
  return { db, selectCount: () => calls };
}

function makeCache(): CacheService {
  return {
    cached: jest.fn().mockResolvedValue("PENDING"),
    set: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

function expectedPreviousMonthWindow(at: Date): { from: string; to: string } {
  const lastDayOfPreviousMonth = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) - DAY_MS,
  );
  const y = lastDayOfPreviousMonth.getUTCFullYear();
  const m = String(lastDayOfPreviousMonth.getUTCMonth() + 1).padStart(2, "0");
  return { from: `${y}-${m}-01`, to: lastDayOfPreviousMonth.toISOString().slice(0, 10) };
}

async function walkYear(): Promise<DayObservation[]> {
  const observations: DayObservation[] = [];
  for (let offset = 0; offset < WALK_DAYS; offset += 1) {
    const at = new Date(WALK_START + offset * DAY_MS);
    jest.setSystemTime(at);

    const { db, selectCount } = makeDb();
    const emit = jest.fn().mockResolvedValue(undefined);
    const svc = new TaxComplianceService(db, makeCache(), {
      emit,
    } as unknown as NotificationDispatchService);

    const results = await svc.checkTaxDue(ORG);
    const first = results[0];
    const emitted = emit.mock.calls[0]?.[0] as
      | { variables?: { period?: string } }
      | undefined;

    observations.push({
      iso: at.toISOString().slice(0, 10),
      dayOfMonth: at.getUTCDate(),
      reachedDb: selectCount() > 0,
      gstr1DueDate: first?.gstr1DueDate,
      gstr3bDueDate: first?.gstr3bDueDate,
      daysUntilGstr1: first?.daysUntilGstr1,
      daysUntilGstr3b: first?.daysUntilGstr3b,
      period: emitted?.variables?.period,
    });
  }
  return observations;
}

/**
 * FIN-TAX-WINDOW. `checkTaxDue` returns [] before touching the database unless a
 * GSTR deadline is within DUE_WARNING_DAYS. Before the fix it computed those
 * deadlines in the month AFTER the filing period rather than the month after the
 * period's END, so the nearest deadline the arithmetic could produce was 11 days
 * out against a threshold of 5 and the window opened on 0 days of 730. A single
 * stubbed `daysBetween` cannot see that; only walking the calendar can.
 */
describe("TaxComplianceService — the GSTR due window over a full calendar walk", () => {
  let observations: DayObservation[];

  beforeAll(async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    observations = await walkYear();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("opens on real days of the year rather than never", () => {
    const opened = observations.filter((d) => d.reachedDb);
    expect(observations).toHaveLength(WALK_DAYS);
    expect(opened.length).toBeGreaterThan(0);
    const monthsCovered = new Set(opened.map((d) => d.iso.slice(0, 7)));
    expect(monthsCovered.size).toBeGreaterThanOrEqual(13);
  });

  it("opens exactly on the days a deadline is within the warning window or past", () => {
    const wrong = observations.filter((d) => d.reachedDb !== d.dayOfMonth >= 11 - DUE_WARNING_DAYS);
    expect(wrong.map((d) => `${d.iso} reachedDb=${String(d.reachedDb)}`)).toEqual([]);
  });

  it("never opens on the first five days of a month, when both deadlines are still far out", () => {
    const early = observations.filter((d) => d.dayOfMonth <= 5);
    expect(early.length).toBeGreaterThan(12);
    expect(early.filter((d) => d.reachedDb).map((d) => d.iso)).toEqual([]);
  });

  it("puts both deadlines in the month of the sweep, on the 11th and the 20th", () => {
    const opened = observations.filter((d) => d.reachedDb);
    const wrong = opened.filter(
      (d) => d.gstr1DueDate !== `${d.iso.slice(0, 7)}-11` || d.gstr3bDueDate !== `${d.iso.slice(0, 7)}-20`,
    );
    expect(wrong.map((d) => `${d.iso} -> ${String(d.gstr1DueDate)} / ${String(d.gstr3bDueDate)}`)).toEqual([]);
  });

  it("reports the distance to each deadline as the real number of days", () => {
    const opened = observations.filter((d) => d.reachedDb);
    const wrong = opened.filter(
      (d) => d.daysUntilGstr1 !== 11 - d.dayOfMonth || d.daysUntilGstr3b !== 20 - d.dayOfMonth,
    );
    expect(wrong.map((d) => `${d.iso} -> ${String(d.daysUntilGstr1)}/${String(d.daysUntilGstr3b)}`)).toEqual([]);
  });

  it("reaches a deadline inside the warning threshold, which the pre-fix arithmetic could not", () => {
    const opened = observations.filter((d) => d.reachedDb);
    const distances = opened.map((d) => d.daysUntilGstr1 ?? Number.NaN);
    const inWindow = distances.filter((n) => n >= 0 && n <= DUE_WARNING_DAYS);
    expect(inWindow.length).toBeGreaterThanOrEqual(WALK_DAYS / 31);
    expect(Math.min(...distances)).toBeLessThanOrEqual(DUE_WARNING_DAYS);
    expect(Math.max(...inWindow)).toBe(DUE_WARNING_DAYS);
  });

  it("reports the filing period as the whole previous calendar month", () => {
    const opened = observations.filter((d) => d.reachedDb);
    const wrong = opened.filter((d) => {
      const { from, to } = expectedPreviousMonthWindow(new Date(`${d.iso}T00:00:00Z`));
      return d.period !== `${from} to ${to}`;
    });
    expect(wrong.map((d) => `${d.iso} -> ${String(d.period)}`)).toEqual([]);
  });

  it("crosses the December to January boundary without moving the year forward", () => {
    const newYear = observations.find((d) => d.iso === "2028-01-11");
    expect(newYear?.reachedDb).toBe(true);
    expect(newYear?.gstr1DueDate).toBe("2028-01-11");
    expect(newYear?.daysUntilGstr1).toBe(0);
    expect(newYear?.period).toBe("2027-12-01 to 2027-12-31");

    const leapFeb = observations.find((d) => d.iso === "2028-03-06");
    expect(leapFeb?.reachedDb).toBe(true);
    expect(leapFeb?.period).toBe("2028-02-01 to 2028-02-29");
  });
});
