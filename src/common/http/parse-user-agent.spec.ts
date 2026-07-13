import {
  parseUserAgent,
  resolveDeviceClientInfo,
  withClientInfo,
  withDeviceClientInfo,
} from "./parse-user-agent";

describe("parseUserAgent", () => {
  it("labels axios as an API client", () => {
    expect(parseUserAgent("axios/1.18.1")).toEqual({
      browser: "Axios 1.18.1",
      os: null,
      platform: null,
    });
  });

  it("parses a Chrome user agent", () => {
    const result = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    expect(result.browser).toBe("Chrome 124");
    expect(result.os).toBe("Windows");
    expect(result.platform).toBe("Desktop");
  });

  it("labels curl as cURL", () => {
    expect(parseUserAgent("curl/8.4.0").browser).toBe("cURL 8.4.0");
  });

  it("returns Unknown for empty input", () => {
    expect(parseUserAgent(null)).toEqual({
      browser: "Unknown",
      os: null,
      platform: null,
    });
  });
});

describe("resolveDeviceClientInfo", () => {
  it("re-parses legacy axios browser tokens from fingerprint", () => {
    expect(
      resolveDeviceClientInfo({
        browser: "axios/1.18.1",
        os: null,
        platform: null,
        fingerprint: "axios/1.18.1",
      }),
    ).toEqual({
      browser: "Axios 1.18.1",
      os: null,
      platform: null,
    });
  });

  it("parses full user agent stored in fingerprint", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const result = resolveDeviceClientInfo({
      browser: "axios/1.18.1",
      os: null,
      platform: null,
      fingerprint: ua,
    });
    expect(result.browser).toBe("Chrome 124");
    expect(result.os).toBe("macOS");
  });
});

describe("withClientInfo", () => {
  it("adds browser and os fields to login history rows", () => {
    expect(
      withClientInfo({
        id: "1",
        userAgent: "axios/1.18.1",
      }),
    ).toMatchObject({
      browser: "Axios 1.18.1",
      os: null,
    });
  });
});

describe("withDeviceClientInfo", () => {
  it("normalizes device rows for API responses", () => {
    expect(
      withDeviceClientInfo({
        id: "d1",
        browser: "axios/1.18.1",
        os: null,
        platform: null,
        fingerprint: "axios/1.18.1",
      }),
    ).toMatchObject({
      browser: "Axios 1.18.1",
      os: null,
    });
  });
});
