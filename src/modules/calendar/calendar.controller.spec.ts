jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { CalendarController } from "./calendar.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { humanSessionPrincipal } from "../../common/auth/principal";

function gateOf(method: keyof CalendarController): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, CalendarController.prototype[method]);
}

describe("CalendarController — organisation-wide reads are gated", () => {
  const gateExpectations: ReadonlyArray<[keyof CalendarController, string]> = [
    ["listAttendees", "calendar:read"],
    ["exportEvents", "calendar:events:export"],
  ];

  it.each(gateExpectations)("%s requires %s", (method, permission) => {
    expect(gateOf(method)).toBe(permission);
  });
});

describe("CalendarController — a member's own calendar cannot be taken away", () => {
  const ownCalendarMethods: ReadonlyArray<keyof CalendarController> = [
    "getEvents",
    "getExternalEvents",
    "createEvent",
    "updateEvent",
    "removeEvent",
    "rsvp",
    "getSources",
    "setSourcePreference",
  ];

  it.each(ownCalendarMethods)("%s carries no permission gate at all", (method) => {
    expect(gateOf(method)).toBeUndefined();
  });
});

describe("CalendarController source preferences", () => {
  const user = {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };

  it("lists sources for the authenticated tenant identity", async () => {
    const getToggleList = jest.fn().mockResolvedValue([
      { key: "tasks", label: "Tasks", module: "tasks", enabled: true },
    ]);
    const controller = new CalendarController(
      {} as never,
      {} as never,
      { getToggleList } as never,
      {} as never,
    );

    await expect(controller.getSources(user)).resolves.toEqual([
      { key: "tasks", label: "Tasks", module: "tasks", enabled: true },
    ]);
    expect(getToggleList).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "user-1" }),
    );
  });

  it("persists a toggle only for the authenticated person and organisation", async () => {
    const setPreference = jest.fn().mockResolvedValue(undefined);
    const controller = new CalendarController(
      {} as never,
      {} as never,
      {} as never,
      { setPreference } as never,
    );

    await expect(
      controller.setSourcePreference("tasks", { enabled: false }, user),
    ).resolves.toEqual({ sourceKey: "tasks", enabled: false });
    expect(setPreference).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "tasks",
      false,
    );
  });
});
