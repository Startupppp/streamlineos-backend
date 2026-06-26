export function subMonths(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  const targetDayOfMonth = result.getDate();
  const firstOfTarget = new Date(date.getTime());
  firstOfTarget.setDate(1);
  firstOfTarget.setMonth(firstOfTarget.getMonth() - amount);
  const daysInTargetMonth = new Date(
    firstOfTarget.getFullYear(),
    firstOfTarget.getMonth() + 1,
    0,
  ).getDate();
  firstOfTarget.setDate(Math.min(targetDayOfMonth, daysInTargetMonth));
  return firstOfTarget;
}

export function startOfMonth(date: Date): Date {
  const result = new Date(date.getTime());
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfMonth(date: Date): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + 1, 0);
  result.setHours(23, 59, 59, 999);
  return result;
}
