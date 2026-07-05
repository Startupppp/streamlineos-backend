import { normalizeGoogleEvents, normalizeOutlookEvents } from "./external-event-normalizers";

const conn = { id: 5, accountEmail: "me@x.com" };

describe("normalizeGoogleEvents", () => {
  it("maps items, drops cancelled, flags all-day", () => {
    const data = {
      items: [
        {
          id: "g1",
          summary: "Standup",
          location: "Room 1",
          hangoutLink: "https://meet.google.com/abc",
          htmlLink: "https://calendar.google.com/e/g1",
          start: { dateTime: "2026-07-10T10:00:00Z" },
          end: { dateTime: "2026-07-10T10:30:00Z" },
        },
        { id: "g2", status: "cancelled", start: { date: "2026-07-11" }, end: { date: "2026-07-12" } },
        { id: "g3", start: { date: "2026-07-11" }, end: { date: "2026-07-12" } },
      ],
    };
    const result = normalizeGoogleEvents(data, conn);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "ext-5-g1",
      providerEventId: "g1",
      title: "Standup",
      meetingUrl: "https://meet.google.com/abc",
      webLink: "https://calendar.google.com/e/g1",
      allDay: false,
      location: "Room 1",
    });
    expect(result[1]).toMatchObject({ id: "ext-5-g3", allDay: true, title: "(no title)" });
  });

  it("skips malformed items and tolerates missing items array", () => {
    expect(normalizeGoogleEvents({}, conn)).toEqual([]);
    expect(normalizeGoogleEvents({ items: [{ bogus: true }] }, conn)).toEqual([]);
  });
});

describe("normalizeOutlookEvents", () => {
  it("maps value entries with UTC times and drops cancelled", () => {
    const data = {
      value: [
        {
          id: "o1",
          subject: "Review",
          isAllDay: false,
          webLink: "https://outlook.office.com/e/o1",
          onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/x" },
          location: { displayName: "HQ" },
          start: { dateTime: "2026-07-10T14:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-07-10T15:00:00.0000000", timeZone: "UTC" },
        },
        {
          id: "o2",
          isCancelled: true,
          start: { dateTime: "2026-07-10T14:00:00" },
          end: { dateTime: "2026-07-10T15:00:00" },
        },
      ],
    };
    const result = normalizeOutlookEvents(data, conn);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "ext-5-o1",
      title: "Review",
      meetingUrl: "https://teams.microsoft.com/l/x",
      location: "HQ",
      start: "2026-07-10T14:00:00.000Z",
      end: "2026-07-10T15:00:00.000Z",
    });
  });

  it("handles offset-carrying datetimes and missing value array", () => {
    expect(normalizeOutlookEvents({}, conn)).toEqual([]);
    const data = {
      value: [
        {
          id: "o3",
          start: { dateTime: "2026-07-10T14:00:00+05:30" },
          end: { dateTime: "2026-07-10T15:00:00+05:30" },
        },
      ],
    };
    const result = normalizeOutlookEvents(data, conn);
    expect(result[0]?.start).toBe("2026-07-10T08:30:00.000Z");
  });
});
