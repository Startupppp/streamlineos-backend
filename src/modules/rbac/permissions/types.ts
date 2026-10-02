export interface Permission<Name extends string = string> {
  name: Name;
  resource: string;
  action: string;
  description: string;
  scopable?: boolean;
  baselineScope?: "own" | "all";
  sensitive?: true;
}

export function definePermissions<const T extends Permission[]>(
  entries: T,
): Permission<T[number]["name"]>[] {
  return entries;
}
