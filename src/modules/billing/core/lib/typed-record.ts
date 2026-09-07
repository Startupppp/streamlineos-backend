export function keysOf<K extends string>(record: Record<K, unknown>): K[] {
  return Object.keys(record) as K[];
}

export function buildRecord<K extends string, V>(
  keys: readonly K[],
  toValue: (key: K) => V,
): Record<K, V> {
  const result = {} as Record<K, V>;
  for (const key of keys) result[key] = toValue(key);
  return result;
}
