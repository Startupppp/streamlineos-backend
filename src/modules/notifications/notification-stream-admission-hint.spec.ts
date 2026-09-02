import { NotificationEventService } from "./notification-event.service";

function reqWith(authorization: string | undefined): unknown {
  return { headers: authorization === undefined ? {} : { authorization } };
}

describe("NotificationEventService.resolveAdmissionTenantOrgId — peek, never verify", () => {
  it("resolves the org a server-minted token was issued for", () => {
    const service = new NotificationEventService();
    const token = service.generateToken("user-1", "org-a");

    expect(service.resolveAdmissionTenantOrgId(reqWith(`Bearer ${token}`))).toBe("org-a");
  });

  it("does not consume the one-shot token, so the handler still verifies it", () => {
    const service = new NotificationEventService();
    const token = service.generateToken("user-1", "org-a");

    service.resolveAdmissionTenantOrgId(reqWith(`Bearer ${token}`));
    service.resolveAdmissionTenantOrgId(reqWith(`Bearer ${token}`));

    expect(service.consumeToken(token)).toEqual({ userId: "user-1", orgId: "org-a" });
    expect(service.consumeToken(token)).toBeNull();
  });

  it("returns undefined once the handler has consumed the token", () => {
    const service = new NotificationEventService();
    const token = service.generateToken("user-1", "org-a");
    service.consumeToken(token);

    expect(service.resolveAdmissionTenantOrgId(reqWith(`Bearer ${token}`))).toBeUndefined();
  });

  it.each([
    ["a forged token", "Bearer 00000000-0000-4000-8000-000000000000"],
    ["a non-bearer scheme", "Basic abcdef"],
    ["an empty bearer", "Bearer "],
    ["a raw token with no scheme", "00000000-0000-4000-8000-000000000000"],
  ])("returns undefined for %s", (_label, authorization) => {
    const service = new NotificationEventService();
    service.generateToken("user-1", "org-a");

    expect(service.resolveAdmissionTenantOrgId(reqWith(authorization))).toBeUndefined();
  });

  it("returns undefined when no authorization header is present", () => {
    const service = new NotificationEventService();
    service.generateToken("user-1", "org-a");

    expect(service.resolveAdmissionTenantOrgId(reqWith(undefined))).toBeUndefined();
  });

  it.each([
    ["a null request", null],
    ["a string request", "not-a-request"],
    ["a request with no headers", {}],
    ["a request whose headers are a string", { headers: "nope" }],
    ["a numeric authorization header", { headers: { authorization: 7 } }],
  ])("returns undefined for %s", (_label, req) => {
    const service = new NotificationEventService();
    service.generateToken("user-1", "org-a");

    expect(service.resolveAdmissionTenantOrgId(req)).toBeUndefined();
  });

  it("ignores an org id the caller supplies in the request itself", () => {
    const service = new NotificationEventService();
    service.generateToken("user-1", "org-a");

    const forged = {
      headers: { authorization: "Bearer nope" },
      query: { orgId: "org-victim" },
      body: { orgId: "org-victim" },
      user: { orgId: "org-victim" },
    };

    expect(service.resolveAdmissionTenantOrgId(forged)).toBeUndefined();
  });

  it("does not resolve an expired token", () => {
    const service = new NotificationEventService();
    const token = service.generateToken("user-1", "org-a");
    const spy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);

    expect(service.resolveAdmissionTenantOrgId(reqWith(`Bearer ${token}`))).toBeUndefined();
    spy.mockRestore();
  });
});
