import { SESSION_LIST_CAP } from "./sessions.service";

describe("SessionsService.list — cap constant", () => {
  it("SESSION_LIST_CAP is 50, matching the admin getUserSessions twin that has always read .limit(50)", () => {
    expect(SESSION_LIST_CAP).toBe(50);
  });
});
