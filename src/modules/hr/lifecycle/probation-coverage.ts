/**
 * Three distinguishable answers, never a boolean: `no-record` means probation was
 * never recorded for this person, which is not the same fact as having finished it.
 */
export type ProbationCoverage = "on-probation" | "past-probation" | "no-record";
