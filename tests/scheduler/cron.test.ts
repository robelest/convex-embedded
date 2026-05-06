import {
  intervalMs,
  nextFireMs,
  parseCronExpression,
  type CronSchedule,
} from "@embedded/scheduler/cron";
import { describe, expect, it } from "@tests/testkit";

const T = (iso: string): number => Date.parse(iso);

describe("scheduler/cron — nextFireMs", () => {
  describe("interval", () => {
    it("first fire schedules one period from now when no last-fire", () => {
      const now = T("2026-05-06T12:00:00Z");
      expect(nextFireMs({ type: "interval", seconds: 30 }, now)).toBe(
        now + 30_000,
      );
      expect(nextFireMs({ type: "interval", minutes: 5 }, now)).toBe(
        now + 5 * 60_000,
      );
      expect(nextFireMs({ type: "interval", hours: 2 }, now)).toBe(
        now + 2 * 3_600_000,
      );
    });

    it("subsequent fires anchor on lastFireMs", () => {
      const last = T("2026-05-06T12:00:00Z");
      const now = T("2026-05-06T12:00:10Z");
      expect(
        nextFireMs({ type: "interval", seconds: 30 }, now, last),
      ).toBe(last + 30_000);
    });

    it("catches up when many intervals were missed", () => {
      const last = T("2026-05-06T12:00:00Z");
      const now = T("2026-05-06T12:05:00Z");
      const next = nextFireMs(
        { type: "interval", seconds: 30 },
        now,
        last,
      );
      expect(next).toBeGreaterThan(now);
      expect(next - now).toBeLessThanOrEqual(30_000);
    });

    it("intervalMs computes the right period", () => {
      expect(intervalMs({ type: "interval", seconds: 45 })).toBe(45_000);
      expect(intervalMs({ type: "interval", minutes: 3 })).toBe(180_000);
      expect(intervalMs({ type: "interval", hours: 1 })).toBe(3_600_000);
    });
  });

  describe("hourly", () => {
    it("returns next occurrence of minuteUTC within the current or next hour", () => {
      const now = T("2026-05-06T12:30:00Z");
      expect(
        nextFireMs({ type: "hourly", minuteUTC: 45 }, now),
      ).toBe(T("2026-05-06T12:45:00Z"));
      expect(
        nextFireMs({ type: "hourly", minuteUTC: 15 }, now),
      ).toBe(T("2026-05-06T13:15:00Z"));
    });

    it("rolls over to next hour exactly at the boundary", () => {
      const now = T("2026-05-06T12:30:00Z");
      expect(
        nextFireMs({ type: "hourly", minuteUTC: 30 }, now),
      ).toBe(T("2026-05-06T13:30:00Z"));
    });
  });

  describe("daily", () => {
    it("returns the same day if scheduled time hasn't passed yet", () => {
      const now = T("2026-05-06T08:00:00Z");
      expect(
        nextFireMs({ type: "daily", hourUTC: 12, minuteUTC: 30 }, now),
      ).toBe(T("2026-05-06T12:30:00Z"));
    });

    it("rolls to tomorrow if scheduled time already passed", () => {
      const now = T("2026-05-06T13:00:00Z");
      expect(
        nextFireMs({ type: "daily", hourUTC: 12, minuteUTC: 30 }, now),
      ).toBe(T("2026-05-07T12:30:00Z"));
    });
  });

  describe("weekly", () => {
    it("fires on the requested day this week if not yet passed", () => {
      // 2026-05-06 is a Wednesday (UTC).
      const now = T("2026-05-06T08:00:00Z");
      const friday: CronSchedule = {
        type: "weekly",
        dayOfWeek: "friday",
        hourUTC: 17,
        minuteUTC: 0,
      };
      expect(nextFireMs(friday, now)).toBe(T("2026-05-08T17:00:00Z"));
    });

    it("rolls to next week if today's scheduled time passed", () => {
      const now = T("2026-05-06T18:00:00Z");
      const wed: CronSchedule = {
        type: "weekly",
        dayOfWeek: "wednesday",
        hourUTC: 17,
        minuteUTC: 0,
      };
      expect(nextFireMs(wed, now)).toBe(T("2026-05-13T17:00:00Z"));
    });
  });

  describe("monthly", () => {
    it("returns same month if day is in the future", () => {
      const now = T("2026-05-06T12:00:00Z");
      expect(
        nextFireMs(
          { type: "monthly", day: 15, hourUTC: 9, minuteUTC: 0 },
          now,
        ),
      ).toBe(T("2026-05-15T09:00:00Z"));
    });

    it("rolls to next month if day already passed", () => {
      const now = T("2026-05-20T12:00:00Z");
      expect(
        nextFireMs(
          { type: "monthly", day: 15, hourUTC: 9, minuteUTC: 0 },
          now,
        ),
      ).toBe(T("2026-06-15T09:00:00Z"));
    });

    it("skips months without the target day (e.g. day=31 in February)", () => {
      const now = T("2026-02-15T12:00:00Z");
      expect(
        nextFireMs(
          { type: "monthly", day: 31, hourUTC: 0, minuteUTC: 0 },
          now,
        ),
      ).toBe(T("2026-03-31T00:00:00Z"));
    });

    it("handles leap-year February", () => {
      const now = T("2024-02-15T12:00:00Z");
      expect(
        nextFireMs(
          { type: "monthly", day: 29, hourUTC: 0, minuteUTC: 0 },
          now,
        ),
      ).toBe(T("2024-02-29T00:00:00Z"));
    });
  });

  describe("cron expression", () => {
    it("parses 5-field expressions", () => {
      const parsed = parseCronExpression("0 9 * * 1-5");
      expect(parsed.minutes).toEqual([0]);
      expect(parsed.hours).toEqual([9]);
      expect(parsed.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it("handles wildcards", () => {
      const parsed = parseCronExpression("*/15 * * * *");
      expect(parsed.minutes).toEqual([0, 15, 30, 45]);
    });

    it("handles month aliases", () => {
      const parsed = parseCronExpression("0 0 1 jan,jul *");
      expect(parsed.months).toEqual([1, 7]);
    });

    it("rejects malformed expressions", () => {
      expect(() => parseCronExpression("0 0 * *")).toThrow();
      expect(() => parseCronExpression("99 0 * * *")).toThrow();
    });

    it("computes next fire for weekday-only schedule", () => {
      const now = T("2026-05-08T10:00:00Z"); // Friday
      // Every weekday at 9am UTC.
      const next = nextFireMs(
        { type: "cron", cron: "0 9 * * 1-5" },
        now,
      );
      expect(next).toBe(T("2026-05-11T09:00:00Z")); // Monday
    });

    it("computes next fire for every-15-minutes", () => {
      const now = T("2026-05-06T12:07:30Z");
      const next = nextFireMs(
        { type: "cron", cron: "*/15 * * * *" },
        now,
      );
      expect(next).toBe(T("2026-05-06T12:15:00Z"));
    });

    it("DOM and DOW are OR'd when both restricted", () => {
      // First of month OR Sunday at midnight.
      const now = T("2026-04-30T12:00:00Z");
      const next = nextFireMs(
        { type: "cron", cron: "0 0 1 * 0" },
        now,
      );
      expect(next).toBe(T("2026-05-01T00:00:00Z"));
    });
  });
});
