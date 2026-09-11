/**
 * What every data-quality check hands back, and the two constants they share.
 *
 * One shape for all eight checks is the point: the report is rendered by a
 * single component that shows a count and up to `OFFENDER_LIMIT` examples, so a
 * check returning anything else would need its own renderer and would stop
 * being comparable with the others.
 */

export const OFFENDER_LIMIT = 10;

export function thirtyDaysAgo(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

export interface DataQualityOffender {
  id: number | string;
  name: string;
  detail?: string;
}

export interface DataQualityAggregate {
  count: number;
  offenders: DataQualityOffender[];
}
