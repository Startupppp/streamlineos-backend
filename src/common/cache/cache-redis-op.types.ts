export type TimedRedisOp = <T>(operation: () => Promise<T>) => Promise<T>;
