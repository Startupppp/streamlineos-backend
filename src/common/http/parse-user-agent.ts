import UAParser from "ua-parser-js";

export type ParsedClientInfo = {
  browser: string;
  os: string | null;
  platform: string | null;
};

type ApiClientRule = {
  test: (ua: string) => boolean;
  label: (ua: string) => string;
};

const API_CLIENT_RULES: ApiClientRule[] = [
  {
    test: (ua) => /^axios(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "Axios"),
  },
  {
    test: (ua) => /^curl(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "cURL"),
  },
  {
    test: (ua) => /^wget(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "Wget"),
  },
  {
    test: (ua) => /^node-fetch(?:\/|$)/i.test(ua),
    label: () => "Node.js Fetch",
  },
  {
    test: (ua) => /^Go-http-client(?:\/|$)/i.test(ua),
    label: () => "Go HTTP Client",
  },
  {
    test: (ua) => /^Java\/[\d._]+/i.test(ua),
    label: () => "Java HTTP Client",
  },
  {
    test: (ua) => /^python-requests(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "Python Requests"),
  },
  {
    test: (ua) => /^PostmanRuntime(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "Postman"),
  },
  {
    test: (ua) => /^okhttp(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "OkHttp"),
  },
  {
    test: (ua) => /^insomnia(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "Insomnia"),
  },
  {
    test: (ua) => /^libwww-perl(?:\/|$)/i.test(ua),
    label: () => "Perl HTTP Client",
  },
  {
    test: (ua) => /^HTTPie(?:\/|$)/i.test(ua),
    label: (ua) => formatClientVersion(ua, "HTTPie"),
  },
];

function formatClientVersion(ua: string, name: string): string {
  const match = ua.match(/\/([\d.]+)/);
  return match?.[1] ? `${name} ${match[1]}` : name;
}

function formatBrowserLabel(name: string, version: string | undefined): string {
  const major = version?.split(".")[0];
  return major ? `${name} ${major}` : name;
}

function detectApiClient(ua: string): string | null {
  for (const rule of API_CLIENT_RULES) {
    if (rule.test(ua)) return rule.label(ua);
  }
  return null;
}

function isBotUserAgent(ua: string): boolean {
  return /bot|crawl|spider|slurp|mediapartners|bingpreview|facebookexternalhit/i.test(ua);
}

function looksLikeFullUserAgent(value: string): boolean {
  return value.includes(" ") || /mozilla\//i.test(value);
}

function looksLikeStoredRawClientToken(value: string): boolean {
  return /^[\w.-]+\/[\d.]+$/i.test(value);
}

function resolvePlatform(deviceType: string | undefined): string | null {
  if (deviceType === "mobile") return "Mobile";
  if (deviceType === "tablet") return "Tablet";
  if (deviceType === "console") return "Console";
  if (deviceType === "smarttv") return "Smart TV";
  if (deviceType === "wearable") return "Wearable";
  if (deviceType === "embedded") return "Embedded";
  return "Desktop";
}

function normalizeOsName(name: string | undefined): string | null {
  if (!name) return null;
  if (name === "Mac OS") return "macOS";
  return name;
}

export function parseUserAgent(userAgent: string | null | undefined): ParsedClientInfo {
  if (!userAgent?.trim()) {
    return { browser: "Unknown", os: null, platform: null };
  }

  const ua = userAgent.trim();

  const apiClient = detectApiClient(ua);
  if (apiClient) {
    return { browser: apiClient, os: null, platform: null };
  }

  if (isBotUserAgent(ua)) {
    return { browser: "Bot", os: null, platform: null };
  }

  const parsed = new UAParser(ua).getResult();
  const browserName = parsed.browser.name
    ? formatBrowserLabel(parsed.browser.name, parsed.browser.version)
    : "Unknown";
  const osName = normalizeOsName(parsed.os.name);

  return {
    browser: browserName,
    os: osName,
    platform: resolvePlatform(parsed.device.type),
  };
}

export function resolveDeviceClientInfo(device: {
  browser: string | null;
  os: string | null;
  platform: string | null;
  fingerprint: string;
}): ParsedClientInfo {
  if (looksLikeFullUserAgent(device.fingerprint)) {
    return parseUserAgent(device.fingerprint);
  }

  if (device.browser && looksLikeStoredRawClientToken(device.browser)) {
    return parseUserAgent(device.browser);
  }

  if (device.browser) {
    return {
      browser: device.browser,
      os: device.os,
      platform: device.platform,
    };
  }

  return parseUserAgent(device.fingerprint);
}

export function withClientInfo<T extends { userAgent: string | null }>(
  entry: T,
): T & { browser: string; os: string | null; platform: string | null } {
  const parsed = parseUserAgent(entry.userAgent);
  return {
    ...entry,
    browser: parsed.browser,
    os: parsed.os,
    platform: parsed.platform,
  };
}

export function withDeviceClientInfo<T extends {
  browser: string | null;
  os: string | null;
  platform: string | null;
  fingerprint: string;
}>(
  device: T,
): T & { browser: string; os: string | null; platform: string | null } {
  const parsed = resolveDeviceClientInfo(device);
  return {
    ...device,
    browser: parsed.browser,
    os: parsed.os,
    platform: parsed.platform,
  };
}
