export const API_VERSION_CURRENT = "1";

export const API_VERSION_NEXT = "2";

export const API_VERSIONS = [API_VERSION_CURRENT, API_VERSION_NEXT] as const;

export type ApiVersion = (typeof API_VERSIONS)[number];
