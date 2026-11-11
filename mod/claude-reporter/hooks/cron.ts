// The next firing of a session's scheduled wake-up (the Stop hook's `session_crons`), read in the machine's local time zone,
// which is the zone Claude Code reads a schedule in. Standard five-field cron (minute, hour, day of month, month, day of
// week); each field is `*`, a number, a range `a-b`, a comma list of those, or a stepped `*/n` / `a-b/n`. A schedule outside
// that grammar yields null: showing no time is more honest than showing a wrong one.

const FIELD_PART = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

/** The values one field allows inside [min, max]; null when any comma-separated part is malformed or out of range. */
function allowedValues(spec: string, min: number, max: number): Set<number> | null {
  const allowed = new Set<number>();
  for (const piece of spec.split(',')) {
    const parsed = FIELD_PART.exec(piece);
    if (parsed === null) return null;
    const [, star, start, end, every] = parsed;
    const stride = every === undefined ? 1 : Number(every);
    let first = min;
    let last = max;
    if (star === undefined) {
      first = Number(start);
      // `a-b` stops at b, a stepped `a/n` runs to the top of the field, and a bare `a` is the one value.
      if (end !== undefined) last = Number(end);
      else if (every === undefined) last = first;
    }
    if (stride < 1 || first < min || last > max || first > last) return null;
    for (let v = first; v <= last; v += stride) allowed.add(v);
  }
  return allowed;
}

/** The first whole minute after `after` (epoch ms) that `schedule` fires at, looked for up to a year ahead; null otherwise. */
export function nextCronAt(schedule: string, after: number): number | null {
  const specs = schedule.trim().split(/\s+/);
  if (specs.length !== 5) return null;
  const [minuteSpec, hourSpec, dateSpec, monthSpec, weekdaySpec] = specs as [string, string, string, string, string];
  const minutes = allowedValues(minuteSpec, 0, 59);
  const hours = allowedValues(hourSpec, 0, 23);
  const dates = allowedValues(dateSpec, 1, 31);
  const months = allowedValues(monthSpec, 1, 12);
  const weekdaysRaw = allowedValues(weekdaySpec, 0, 7);
  if (minutes === null || hours === null || dates === null || months === null || weekdaysRaw === null) return null;
  // Sunday may be written 0 or 7.
  const weekdays = new Set([...weekdaysRaw].map((d) => d % 7));
  // Cron's day rule: when both day fields are restricted, a day qualifies if either one matches.
  const datesRestricted = dateSpec !== '*';
  const weekdaysRestricted = weekdaySpec !== '*';
  const isRunDay = (at: Date): boolean => {
    const byDate = dates.has(at.getDate());
    const byWeekday = weekdays.has(at.getDay());
    if (datesRestricted && weekdaysRestricted) return byDate || byWeekday;
    if (datesRestricted) return byDate;
    return weekdaysRestricted ? byWeekday : true;
  };
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  // One pass moves the cursor by a day, an hour or a minute, so a year of minutes bounds the search.
  const passes = 366 * 24 * 60;
  for (let pass = 0; pass < passes; pass++) {
    const dayFits = months.has(cursor.getMonth() + 1) && isRunDay(cursor);
    if (dayFits && hours.has(cursor.getHours())) {
      if (minutes.has(cursor.getMinutes())) return cursor.getTime();
      cursor.setMinutes(cursor.getMinutes() + 1);
    } else if (dayFits) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
    } else {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
    }
  }
  return null;
}
