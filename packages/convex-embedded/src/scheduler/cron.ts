export type CronSchedule =
  | { type: "interval"; seconds: number }
  | { type: "interval"; minutes: number }
  | { type: "interval"; hours: number }
  | { type: "hourly"; minuteUTC: number }
  | { type: "daily"; hourUTC: number; minuteUTC: number }
  | {
      type: "weekly";
      dayOfWeek:
        | "sunday"
        | "monday"
        | "tuesday"
        | "wednesday"
        | "thursday"
        | "friday"
        | "saturday";
      hourUTC: number;
      minuteUTC: number;
    }
  | { type: "monthly"; day: number; hourUTC: number; minuteUTC: number }
  | { type: "cron"; cron: string };

const DAYS_OF_WEEK = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export function intervalMs(
  schedule: Extract<CronSchedule, { type: "interval" }>,
): number {
  if ("seconds" in schedule) return schedule.seconds * 1000;
  if ("minutes" in schedule) return schedule.minutes * 60_000;
  if ("hours" in schedule) return schedule.hours * 3_600_000;
  return 0;
}

export function nextFireMs(
  schedule: CronSchedule,
  nowMs: number,
  lastFireMs?: number,
): number {
  switch (schedule.type) {
    case "interval": {
      const periodMs = intervalMs(schedule);
      if (periodMs <= 0) return nowMs;
      if (lastFireMs === undefined) return nowMs + periodMs;
      const next = lastFireMs + periodMs;
      if (next > nowMs) return next;
      const missed = Math.floor((nowMs - lastFireMs) / periodMs);
      return lastFireMs + (missed + 1) * periodMs;
    }
    case "hourly":
      return nextHourly(nowMs, schedule.minuteUTC);
    case "daily":
      return nextDaily(nowMs, schedule.hourUTC, schedule.minuteUTC);
    case "weekly":
      return nextWeekly(
        nowMs,
        DAYS_OF_WEEK.indexOf(schedule.dayOfWeek),
        schedule.hourUTC,
        schedule.minuteUTC,
      );
    case "monthly":
      return nextMonthly(
        nowMs,
        schedule.day,
        schedule.hourUTC,
        schedule.minuteUTC,
      );
    case "cron":
      return nextCronExpression(schedule.cron, nowMs);
  }
}

function nextHourly(nowMs: number, minuteUTC: number): number {
  const d = new Date(nowMs);
  const target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    minuteUTC,
    0,
    0,
  );
  return target > nowMs ? target : target + 3_600_000;
}

function nextDaily(
  nowMs: number,
  hourUTC: number,
  minuteUTC: number,
): number {
  const d = new Date(nowMs);
  const target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    hourUTC,
    minuteUTC,
    0,
    0,
  );
  return target > nowMs ? target : target + 86_400_000;
}

function nextWeekly(
  nowMs: number,
  dayOfWeek: number,
  hourUTC: number,
  minuteUTC: number,
): number {
  const d = new Date(nowMs);
  const todayDow = d.getUTCDay();
  const daysAhead = (dayOfWeek - todayDow + 7) % 7;
  const target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + daysAhead,
    hourUTC,
    minuteUTC,
    0,
    0,
  );
  if (target > nowMs) return target;
  return target + 7 * 86_400_000;
}

function nextMonthly(
  nowMs: number,
  day: number,
  hourUTC: number,
  minuteUTC: number,
): number {
  const d = new Date(nowMs);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const lastDay = daysInMonth(year, month);
    if (day <= lastDay) {
      const target = Date.UTC(year, month, day, hourUTC, minuteUTC, 0, 0);
      if (target > nowMs) return target;
    }
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  // Should be unreachable for valid `day` (1..31).
  return nowMs + 30 * 86_400_000;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

function parseCronField(
  raw: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): number[] {
  const out = new Set<number>();
  const tokens = raw.split(",");
  for (const token of tokens) {
    let stepStr: string | undefined;
    let body = token;
    const slashIdx = body.indexOf("/");
    if (slashIdx >= 0) {
      stepStr = body.slice(slashIdx + 1);
      body = body.slice(0, slashIdx);
    }
    const step = stepStr === undefined ? 1 : parseStrictInt(stepStr);
    if (step <= 0) {
      throw new Error(`Invalid cron step "${token}"`);
    }
    let start: number;
    let end: number;
    if (body === "*") {
      start = min;
      end = max;
    } else if (body.includes("-")) {
      const dashIdx = body.indexOf("-");
      start = resolveCronAtom(body.slice(0, dashIdx), aliases);
      end = resolveCronAtom(body.slice(dashIdx + 1), aliases);
    } else {
      start = resolveCronAtom(body, aliases);
      end = start;
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Cron field out of range: "${token}"`);
    }
    for (let value = start; value <= end; value += step) {
      out.add(value);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

function resolveCronAtom(
  raw: string,
  aliases?: Record<string, number>,
): number {
  const trimmed = raw.trim();
  if (aliases) {
    const lookup = aliases[trimmed.toLowerCase()];
    if (lookup !== undefined) return lookup;
  }
  return parseStrictInt(trimmed);
}

function parseStrictInt(raw: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Cron value not an integer: "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

const CRON_MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const CRON_DAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (minute hour day-of-month month day-of-week); got "${expression}"`,
    );
  }
  return {
    minutes: parseCronField(fields[0]!, 0, 59),
    hours: parseCronField(fields[1]!, 0, 23),
    daysOfMonth: parseCronField(fields[2]!, 1, 31),
    months: parseCronField(fields[3]!, 1, 12, CRON_MONTH_ALIASES),
    daysOfWeek: parseCronField(fields[4]!, 0, 6, CRON_DAY_ALIASES),
  };
}

function nextCronExpression(expression: string, nowMs: number): number {
  const parsed = parseCronExpression(expression);
  const dowAny = parsed.daysOfWeek.length === 7;
  const domAny = parsed.daysOfMonth.length === 31;

  let cursor = nowMs - (nowMs % 60_000) + 60_000;
  for (let attempt = 0; attempt < 366 * 24 * 60; attempt += 1) {
    const d = new Date(cursor);
    const month = d.getUTCMonth() + 1;
    if (!parsed.months.includes(month)) {
      const next = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        1,
        0,
        0,
        0,
        0,
      );
      cursor = next;
      continue;
    }
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();
    const domMatch = parsed.daysOfMonth.includes(dom);
    const dowMatch = parsed.daysOfWeek.includes(dow);
    const dayMatches =
      dowAny && domAny
        ? true
        : dowAny
          ? domMatch
          : domAny
            ? dowMatch
            : domMatch || dowMatch;
    if (!dayMatches) {
      const next = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      );
      cursor = next;
      continue;
    }
    const hour = d.getUTCHours();
    if (!parsed.hours.includes(hour)) {
      cursor += 60 * 60_000;
      cursor = cursor - (cursor % 60_000);
      continue;
    }
    const minute = d.getUTCMinutes();
    if (!parsed.minutes.includes(minute)) {
      cursor += 60_000;
      continue;
    }
    return cursor;
  }
  throw new Error(`No cron firing within a year for "${expression}"`);
}
