// Days as the dashboard counts them: the server's own calendar, written `YYYY-MM-DD`. Today, the week, the spend record and
// History all go by it. It imports nothing, so the History page shares this file.

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The server-local day that the epoch-ms instant `at` falls on. */
export const localDay = (at: number): string => {
  const when = new Date(at);
  return [String(when.getFullYear()), pad2(when.getMonth() + 1), pad2(when.getDate())].join('-');
};

/** The day `n` calendar days after `day` (before it when `n` is negative); a 23- or 25-hour day still counts as one. */
export const addDays = (day: string, n: number): string => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(year, month - 1, date + n).getTime());
};
