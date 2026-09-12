import { csvEscape, formatDate, formatDatetime } from "./calendar-export-format";
import { toWallClockUtc } from "../../common/date/zoned-wall-clock";

describe("csvEscape — quoting triggers", () => {
  it("returns a plain value unchanged", () => {
    expect(csvEscape("hello world")).toBe("hello world");
  });

  it("quotes when value contains a double-quote and escapes it", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes when value contains a comma", () => {
    expect(csvEscape("London, UK")).toBe('"London, UK"');
  });

  it("quotes when value contains LF (\\n)", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes when value contains CR (\\r) — previously unhandled", () => {
    expect(csvEscape("a\rb")).toBe('"a\rb"');
  });

  it("quotes when value contains CRLF", () => {
    expect(csvEscape("a\r\nb")).toBe('"a\r\nb"');
  });
});

describe("csvEscape — formula-injection neutralization", () => {
  it.each(["=", "+", "-", "@"])("prepends a single quote to a '%s'-leading value", (ch) => {
    const input = `${ch}SUM(A1:A5)`;
    const result = csvEscape(input);
    expect(result.startsWith("'")).toBe(true);
    expect(result).toContain(input);
  });

  it("does not alter a value whose formula character is not in the leading position", () => {
    expect(csvEscape("total=5")).toBe("total=5");
    expect(csvEscape("note: -3")).toBe("note: -3");
  });

  it("quotes the neutralized value when it also contains a double-quote", () => {
    const result = csvEscape('=HYPERLINK("http://x.co","click")');
    expect(result.startsWith('"')).toBe(true);
    expect(result).toContain("'=");
  });

  it("neutralizes a tab-leading value (DDE variant)", () => {
    const result = csvEscape("\t=SUM(A1)");
    expect(result.startsWith("'")).toBe(true);
  });
});

describe("formatDate — timezone-aware wall-clock date", () => {
  it("returns the correct date in the event's IANA timezone", () => {
    const instant = new Date("2026-09-12T01:00:00Z");
    expect(formatDate(instant, "America/New_York")).toBe("2026-09-11");
  });

  it("falls back to UTC when timezone is null", () => {
    const instant = new Date("2026-09-12T01:00:00Z");
    expect(formatDate(instant, null)).toBe("2026-09-12");
  });

  it("agrees with toWallClockUtc UTC getters for Asia/Kolkata", () => {
    const instant = new Date("2026-09-12T07:30:00Z");
    const wall = toWallClockUtc(instant, "Asia/Kolkata");
    const expected = [
      wall.getUTCFullYear(),
      String(wall.getUTCMonth() + 1).padStart(2, "0"),
      String(wall.getUTCDate()).padStart(2, "0"),
    ].join("-");
    expect(formatDate(instant, "Asia/Kolkata")).toBe(expected);
  });

  it("handles a DST spring-forward transition correctly (America/New_York)", () => {
    const beforeSpringForward = new Date("2024-03-10T06:30:00Z");
    expect(formatDate(beforeSpringForward, "America/New_York")).toBe("2024-03-10");
    const afterSpringForward = new Date("2024-03-10T07:30:00Z");
    expect(formatDate(afterSpringForward, "America/New_York")).toBe("2024-03-10");
  });

  it("BITE: a server-local formatter disagrees with the NY wall-clock date for a pre-midnight UTC event", () => {
    const instant = new Date("2026-09-12T01:00:00Z");
    const nyResult = formatDate(instant, "America/New_York");
    const utcResult = formatDate(instant, null);
    expect(nyResult).toBe("2026-09-11");
    expect(utcResult).toBe("2026-09-12");
    expect(nyResult).not.toBe(utcResult);
  });
});

describe("formatDatetime — timezone-aware wall-clock datetime", () => {
  it("returns the correct datetime in the event's IANA timezone", () => {
    const instant = new Date("2026-09-12T01:30:00Z");
    expect(formatDatetime(instant, "America/New_York")).toBe("2026-09-11 21:30");
  });

  it("falls back to UTC when timezone is null", () => {
    const instant = new Date("2026-09-12T01:30:00Z");
    expect(formatDatetime(instant, null)).toBe("2026-09-12 01:30");
  });

  it("pads single-digit hours and minutes", () => {
    const instant = new Date("2026-09-12T05:05:00Z");
    expect(formatDatetime(instant, "UTC")).toBe("2026-09-12 05:05");
  });

  it("handles midnight (00:00) correctly", () => {
    const instant = new Date("2026-03-04T05:00:00Z");
    expect(formatDatetime(instant, "America/New_York")).toBe("2026-03-04 00:00");
  });

  it("BITE: server-local formatter disagrees with NY wall clock time for a pre-midnight UTC event", () => {
    const instant = new Date("2026-09-12T01:30:00Z");
    const nyResult = formatDatetime(instant, "America/New_York");
    const utcResult = formatDatetime(instant, null);
    expect(nyResult).toBe("2026-09-11 21:30");
    expect(utcResult).toBe("2026-09-12 01:30");
    expect(nyResult).not.toBe(utcResult);
  });
});
