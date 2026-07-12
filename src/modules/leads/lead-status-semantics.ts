export interface LeadStatusSemantics {
  convertedKeys: string[];
  lostKeys: string[];
  activeKeys: string[];
  slaOpenKeys: string[];
}

const FALLBACK_CONVERTED = ["CONVERTED"];
const FALLBACK_LOST = ["LOST"];
const FALLBACK_ACTIVE = ["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"];

export function resolveLeadStatusSemantics(
  options: Array<{ key: string; isTerminal: boolean; metadata: Record<string, unknown> | null }>,
): LeadStatusSemantics {
  if (options.length === 0) {
    return {
      convertedKeys: FALLBACK_CONVERTED,
      lostKeys: FALLBACK_LOST,
      activeKeys: FALLBACK_ACTIVE,
      slaOpenKeys: FALLBACK_ACTIVE,
    };
  }

  const convertedKeys = options
    .filter((o) => o.isTerminal && o.metadata?.semantic !== "lost")
    .map((o) => o.key);

  const lostKeys = options
    .filter((o) => o.isTerminal && o.metadata?.semantic === "lost")
    .map((o) => o.key);

  const activeKeys = options
    .filter((o) => !o.isTerminal)
    .map((o) => o.key);

  return {
    convertedKeys: convertedKeys.length > 0 ? convertedKeys : FALLBACK_CONVERTED,
    lostKeys: lostKeys.length > 0 ? lostKeys : FALLBACK_LOST,
    activeKeys: activeKeys.length > 0 ? activeKeys : FALLBACK_ACTIVE,
    slaOpenKeys: activeKeys.length > 0 ? activeKeys : FALLBACK_ACTIVE,
  };
}
