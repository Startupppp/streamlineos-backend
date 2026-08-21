jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { CalendarController } from "./calendar.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions/role-defaults";

describe("CalendarController RBAC metadata", () => {
  const gateExpectations: ReadonlyArray<[keyof CalendarController, string]> = [
    ["getEvents", "calendar:read"],
    ["getExternalEvents", "calendar:read"],
    ["createEvent", "calendar:write"],
    ["updateEvent", "calendar:write"],
    ["removeEvent", "calendar:write"],
    ["rsvp", "calendar:write"],
    ["listAttendees", "calendar:read"],
    ["exportEvents", "calendar:events:export"],
  ];

  it.each(gateExpectations)("%s requires %s", (method, permission) => {
    const handler = CalendarController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(permission);
  });
});

describe("CalendarController universal own-calendar guarantee", () => {
  const memberPermissions = new Set(ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []);

  const ownCalendarMethods: ReadonlyArray<keyof CalendarController> = [
    "getEvents",
    "getExternalEvents",
    "createEvent",
    "updateEvent",
    "removeEvent",
    "rsvp",
  ];

  it.each(ownCalendarMethods)(
    "own-calendar route %s carries no gate a member could lack",
    (method) => {
      const handler = CalendarController.prototype[method];
      const key: string | undefined = Reflect.getMetadata(REQUIRE_PERMISSION, handler);
      if (key !== undefined && key !== null)
        expect(memberPermissions.has(key)).toBe(true);
    },
  );
});
