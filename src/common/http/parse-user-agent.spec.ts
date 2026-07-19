import {
  enrichUserAgent,
  parseUserAgent,
  resolveDeviceClientInfo,
  withClientInfo,
  withDeviceClientInfo,
} from "./parse-user-agent";

const ELECTRON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.291 Electron/39.0.0 Safari/537.36";

const ELECTRON_PRODUCT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) StreamlineOS/1.2.0 Chrome/120.0.6099.291 Electron/39.0.0 Safari/537.36";

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

  it("labels Electron shells as StreamlineOS Desktop without engine version", () => {
    const result = parseUserAgent(ELECTRON_UA);
    expect(result.browser).toBe("StreamlineOS Desktop");
    expect(result.os).toBe("Windows");
    expect(result.platform).toBe("Desktop");
  });

  it("prefers StreamlineOS product token over Electron engine label", () => {
    const result = parseUserAgent(ELECTRON_PRODUCT_UA);
    expect(result.browser).toBe("StreamlineOS Desktop");
    expect(result.os).toBe("macOS");
  });

  it("honors x-client-app hints for desktop shells", () => {
    const result = parseUserAgent(ELECTRON_UA, { clientApp: "StreamlineOS Desktop" });
    expect(result.browser).toBe("StreamlineOS Desktop");
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

describe("enrichUserAgent", () => {
  it("appends a StreamlineOS product token from client-app hints", () => {
    expect(enrichUserAgent(ELECTRON_UA, { clientApp: "StreamlineOS Desktop" })).toContain(
      "StreamlineOS/Desktop",
    );
  });

  it("does not duplicate StreamlineOS tokens", () => {
    const enriched = enrichUserAgent(ELECTRON_PRODUCT_UA, { clientApp: "StreamlineOS Desktop" });
    expect(enriched.match(/StreamlineOS/gi)?.length).toBe(1);
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

  it("relabels legacy stored Electron browser labels", () => {
    expect(
      resolveDeviceClientInfo({
        browser: "Electron 39",
        os: "Windows",
        platform: "Desktop",
        fingerprint: "device-fp-1",
      }),
    ).toEqual({
      browser: "StreamlineOS Desktop",
      os: "Windows",
      platform: "Desktop",
    });
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
