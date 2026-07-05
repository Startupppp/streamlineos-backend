import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import type { ComposioGateway } from "../integrations/composio.gateway";

describe("ExternalCalendarSyncService", () => {
  const conn = { id: 3, toolkit: "googlecalendar" as const, composioConnectedAccountId: "ca_1" };
  const input = {
    title: "Sync",
    description: null,
    startIso: "2026-07-10T10:00:00.000Z",
    endIso: "2026-07-10T11:00:00.000Z",
    allDay: false,
    attendeeEmails: ["a@x.com"],
    addConference: true,
  };

  it("returns the Meet link from a Google create", async () => {
    const gateway = {
      executeTool: jest.fn().mockResolvedValue({ id: "gev1", hangoutLink: "https://meet.google.com/xyz" }),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    const result = await service.pushCreate("u1", conn, input);
    expect(result).toEqual({ externalEventId: "gev1", meetingUrl: "https://meet.google.com/xyz" });
    expect(gateway.executeTool).toHaveBeenCalledWith(
      "GOOGLECALENDAR_CREATE_EVENT",
      "u1",
      expect.objectContaining({ create_meeting_room: true, attendees: ["a@x.com"] }),
      "ca_1",
    );
  });

  it("returns the Teams link from an Outlook create", async () => {
    const gateway = {
      executeTool: jest.fn().mockResolvedValue({
        id: "oev1",
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/j" },
      }),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    const result = await service.pushCreate("u1", { ...conn, toolkit: "outlook" }, input);
    expect(result).toEqual({ externalEventId: "oev1", meetingUrl: "https://teams.microsoft.com/l/j" });
  });

  it("throws when Google returns no event id", async () => {
    const gateway = {
      executeTool: jest.fn().mockResolvedValue({}),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    await expect(service.pushCreate("u1", conn, input)).rejects.toThrow(
      "Google Calendar did not return an event id",
    );
  });

  it("throws when Outlook returns no event id", async () => {
    const gateway = {
      executeTool: jest.fn().mockResolvedValue({}),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    await expect(service.pushCreate("u1", { ...conn, toolkit: "outlook" }, input)).rejects.toThrow(
      "Outlook did not return an event id",
    );
  });

  it("pushUpdate only calls executeTool for Google", async () => {
    const gateway = {
      executeTool: jest.fn().mockResolvedValue({}),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    await service.pushUpdate("u1", conn, "gev1", {
      title: "Updated",
      description: null,
      startIso: "2026-07-10T10:00:00.000Z",
      endIso: "2026-07-10T11:00:00.000Z",
    });
    expect(gateway.executeTool).toHaveBeenCalledWith(
      "GOOGLECALENDAR_UPDATE_EVENT",
      "u1",
      expect.objectContaining({ event_id: "gev1", summary: "Updated" }),
      "ca_1",
    );
  });

  it("pushUpdate is a no-op for Outlook", async () => {
    const gateway = {
      executeTool: jest.fn(),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    await service.pushUpdate("u1", { ...conn, toolkit: "outlook" }, "oev1", {
      title: "Updated",
      description: null,
      startIso: "2026-07-10T10:00:00.000Z",
      endIso: "2026-07-10T11:00:00.000Z",
    });
    expect(gateway.executeTool).not.toHaveBeenCalled();
  });

  it("pushDelete only calls executeTool for Google", async () => {
    const gateway = {
      executeTool: jest.fn().mockResolvedValue({}),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    await service.pushDelete("u1", conn, "gev1");
    expect(gateway.executeTool).toHaveBeenCalledWith(
      "GOOGLECALENDAR_DELETE_EVENT",
      "u1",
      { event_id: "gev1" },
      "ca_1",
    );
  });

  it("pushDelete is a no-op for Outlook", async () => {
    const gateway = {
      executeTool: jest.fn(),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    await service.pushDelete("u1", { ...conn, toolkit: "outlook" }, "oev1");
    expect(gateway.executeTool).not.toHaveBeenCalled();
  });

  it("unwraps response_data envelope from Composio", async () => {
    const gateway = {
      executeTool: jest
        .fn()
        .mockResolvedValue({ response_data: { id: "gev2", hangoutLink: "https://meet.google.com/abc" } }),
    } as unknown as ComposioGateway;
    const service = new ExternalCalendarSyncService(gateway);
    const result = await service.pushCreate("u1", conn, { ...input, addConference: false });
    expect(result.externalEventId).toBe("gev2");
    expect(result.meetingUrl).toBe("https://meet.google.com/abc");
  });
});
