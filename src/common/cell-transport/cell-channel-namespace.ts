export function cellChannelPrefix(cellId: string): string {
  return `cell:${cellId}`;
}

export function cellPrefixed(cellId: string, channel: string): string {
  return `${cellChannelPrefix(cellId)}:${channel}`;
}

export function cellCapabilityGlob(cellId: string): string {
  return `${cellChannelPrefix(cellId)}:*`;
}
