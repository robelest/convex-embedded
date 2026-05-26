/**
 * OpenTelemetry metrics helpers used by the embedded runtime to emit
 * counters (cumulative — replay successes, http dispatch results,
 * cron firings) and gauges (instantaneous — pending queue depth,
 * pending uploads depth, cache entry count). The runtime calls these
 * at strategic points; consumers inspect via the in-memory tracer's
 * `getMetrics()` or pipe to a real OTel collector.
 *
 * @packageDocumentation
 */

import type {
  Attributes,
  Counter,
  Histogram,
  ObservableGauge,
} from "@opentelemetry/api";

import { getMeter } from "@/tracing/spans";

const METRIC_PREFIX = "convex.embedded.";

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

function histogramFor(name: string, description?: string): Histogram {
  let histogram = histograms.get(name);
  if (histogram) return histogram;
  histogram = getMeter().createHistogram(`${METRIC_PREFIX}${name}`, {
    description,
    unit: "ms",
  });
  histograms.set(name, histogram);
  return histogram;
}

/**
 * Record a value into a named latency histogram, lazily creating the OTel
 * `Histogram` instrument (unit `ms`) on first call. The full metric name is
 * `convex.embedded.<name>`. Use for durations whose distribution matters —
 * e.g. SQLite worker queue-wait and execution time.
 *
 * @param name — short, dot-separated metric name (no prefix).
 * @param value — the measurement (milliseconds).
 * @param attributes — optional attribute set; histograms with different
 *   attribute sets aggregate independently.
 *
 * @public
 */
export function recordHistogram(
  name: string,
  value: number,
  attributes?: Attributes,
): void {
  histogramFor(name).record(value, attributes);
}

function counterFor(name: string, description?: string): Counter {
  let counter = counters.get(name);
  if (counter) return counter;
  counter = getMeter().createCounter(`${METRIC_PREFIX}${name}`, {
    description,
  });
  counters.set(name, counter);
  return counter;
}

/**
 * Increment a named counter, lazily creating the OTel `Counter`
 * instrument on first call. The full metric name is
 * `convex.embedded.<name>` (so `recordCounter("replay.success")`
 * reports `convex.embedded.replay.success`).
 *
 * @param name — short, dot-separated metric name (no prefix).
 * @param attributes — optional attribute set; counters with different
 *   attribute sets aggregate independently.
 * @param value — increment amount (default 1; use larger values for
 *   batched events).
 *
 * @public
 */
export function recordCounter(
  name: string,
  attributes?: Attributes,
  value: number = 1,
): void {
  counterFor(name).add(value, attributes);
}

const gaugeRegistrations = new Map<string, () => number>();
let gaugeRegistered = false;

function ensureGaugeProvider(): void {
  if (gaugeRegistered) return;
  gaugeRegistered = true;
  const meter = getMeter();
  const gauge: ObservableGauge = meter.createObservableGauge(
    `${METRIC_PREFIX}runtime.state`,
    {
      description:
        "Generic embedded-runtime gauge. The `state` attribute names the metric and the value is the latest reading from a registered observable.",
    },
  );
  meter.addBatchObservableCallback(
    (observableResult) => {
      for (const [stateName, read] of gaugeRegistrations) {
        let value: number;
        try {
          value = read();
        } catch {
          continue;
        }
        if (!Number.isFinite(value)) continue;
        observableResult.observe(gauge, value, { state: stateName });
      }
    },
    [gauge],
  );
}

/**
 * Register an observable gauge. The runtime polls `read()` on each
 * metrics collection cycle (typically once per minute when piped to a
 * collector, or on-demand via `installInMemoryTracing().getMetrics()`).
 *
 * All gauges share a single OTel `convex.embedded.runtime.state`
 * observable, distinguished by the `state` attribute. This avoids
 * creating one OTel instrument per metric — a practical concession
 * since each instrument has a non-trivial cost and we have many
 * gauges (queue depths, cache entries, processor lease state, etc.).
 *
 * @returns an `unregister` function. Engines call this in their
 *   shutdown path so torn-down components stop being polled.
 *
 * @public
 */
export function registerGauge(name: string, read: () => number): () => void {
  ensureGaugeProvider();
  gaugeRegistrations.set(name, read);
  return () => {
    gaugeRegistrations.delete(name);
  };
}

/**
 * Reset every counter + gauge registration. Tests + module-hot-reload
 * scenarios only — calling this in production silently drops metrics.
 *
 * @internal
 */
export function resetMetricsRegistrations(): void {
  counters.clear();
  histograms.clear();
  gaugeRegistrations.clear();
  gaugeRegistered = false;
}
