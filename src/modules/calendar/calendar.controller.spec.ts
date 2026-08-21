jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { CalendarController } from "./calendar.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";

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
  ];

  it.each(ownCalendarMethods)("%s carries no permission gate at all", (method) => {
    expect(gateOf(method)).toBeUndefined();
  });
});
