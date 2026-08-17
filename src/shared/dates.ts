/** UTC calendar-day helpers (YYYY-MM-DD) used across collection and reporting. */

/** Format a `Date` as a UTC calendar day (YYYY-MM-DD). */
function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The previous UTC calendar day (the period daily collection targets). */
export function yesterdayIso(): string {
  return toDayString(new Date(Date.now() - 86_400_000));
}