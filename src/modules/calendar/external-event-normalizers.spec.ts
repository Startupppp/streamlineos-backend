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

  it("carries the zone the event was authored in", () => {
    const data = {
      items: [
        {
          id: "g4",
          summary: "Partner sync",
          start: { dateTime: "2027-09-14T10:00:00-04:00", timeZone: "America/New_York" },
          end: { dateTime: "2027-09-14T11:00:00-04:00", timeZone: "America/New_York" },
        },
      ],
    };
    const result = normalizeGoogleEvents(data, conn);
    expect(result[0]?.timezone).toBe("America/New_York");
    expect(result[0]?.start).toBe("2027-09-14T14:00:00.000Z");
  });

  it("reports no zone when the provider states none", () => {
    const data = {
      items: [
        {
          id: "g5",
          start: { dateTime: "2027-09-14T14:00:00Z" },
          end: { dateTime: "2027-09-14T15:00:00Z" },
        },
      ],
    };
    expect(normalizeGoogleEvents(data, conn)[0]?.timezone).toBeNull();
  });

  it("reports no zone for an all-day event, which has a date and no wall clock", () => {
    const data = {
      items: [
        { id: "g6", start: { date: "2026-07-11", timeZone: "America/New_York" }, end: { date: "2026-07-12" } },
      ],
    };
    const result = normalizeGoogleEvents(data, conn);
    expect(result[0]?.allDay).toBe(true);
    expect(result[0]?.timezone).toBeNull();
  });

  it("drops a zone the runtime cannot resolve rather than shipping it to the client", () => {
    const data = {
      items: [
        {
          id: "g7",
          start: { dateTime: "2027-09-14T14:00:00Z", timeZone: "India Standard Time" },
          end: { dateTime: "2027-09-14T15:00:00Z", timeZone: "India Standard Time" },
        },
      ],
    };
    expect(normalizeGoogleEvents(data, conn)[0]?.timezone).toBeNull();
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

  it("carries the booked zone from originalStartTimeZone, not the rendering zone", () => {
    const data = {
      value: [
        {
          id: "o4",
          subject: "Review",
          originalStartTimeZone: "America/New_York",
          start: { dateTime: "2027-09-14T14:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2027-09-14T15:00:00.0000000", timeZone: "UTC" },
        },
      ],
    };
    const result = normalizeOutlookEvents(data, conn);
    expect(result[0]?.timezone).toBe("America/New_York");
    expect(result[0]?.start).toBe("2027-09-14T14:00:00.000Z");
  });

  it("anchors a naive dateTime in the zone the payload says it is written in", () => {
    const data = {
      value: [
        {
          id: "o5",
          start: { dateTime: "2027-09-14T19:30:00.0000000", timeZone: "Asia/Kolkata" },
          end: { dateTime: "2027-09-14T20:30:00.0000000", timeZone: "Asia/Kolkata" },
        },
      ],
    };
    const result = normalizeOutlookEvents(data, conn);
    expect(result[0]?.start).toBe("2027-09-14T14:00:00.000Z");
    expect(result[0]?.timezone).toBe("Asia/Kolkata");
  });

  it("reports no zone for an all-day event and none when the payload states none", () => {
    const data = {
      value: [
        {
          id: "o6",
          isAllDay: true,
          originalStartTimeZone: "Asia/Kolkata",
          start: { dateTime: "2026-07-10T00:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-07-11T00:00:00.0000000", timeZone: "UTC" },
        },
        {
          id: "o7",
          start: { dateTime: "2026-07-10T14:00:00+05:30" },
          end: { dateTime: "2026-07-10T15:00:00+05:30" },
        },
      ],
    };
    const result = normalizeOutlookEvents(data, conn);
    expect(result[0]?.timezone).toBeNull();
    expect(result[1]?.timezone).toBeNull();
  });
});
