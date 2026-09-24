export function withDelegatingTransaction<T extends object>(double: T): T {
  const withExecute =
    "execute" in double ? double : Object.assign(double, { execute: async () => [] });
  return Object.assign(withExecute, {
    transaction: (run: (tx: T) => unknown) => run(double),
  });
}
