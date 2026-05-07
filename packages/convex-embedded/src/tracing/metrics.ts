import type { Attributes, Counter, ObservableGauge } from "@opentelemetry/api";

import { getMeter } from "@/tracing/spans";

const METRIC_PREFIX = "convex.embedded.";

const counters = new Map<string, Counter>();

function counterFor(name: string, description?: string): Counter {
  let counter = counters.get(name);
  if (counter) return counter;
  counter = getMeter().createCounter(`${METRIC_PREFIX}${name}`, {
    description,
  });
  counters.set(name, counter);
  return counter;
}

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
 * Register an observable gauge. The runtime polls `read()` on each metrics
 * collection cycle. `name` becomes the `state` attribute value on the
 * shared `convex.embedded.runtime.state` gauge.
 *
 * Returns an `unregister` function.
 */
export function registerGauge(
  name: string,
  read: () => number,
): () => void {
  ensureGaugeProvider();
  gaugeRegistrations.set(name, read);
  return () => {
    gaugeRegistrations.delete(name);
  };
}

/** Reset all metric registrations. Tests + module-hot-reload only. */
export function resetMetricsRegistrations(): void {
  counters.clear();
  gaugeRegistrations.clear();
  gaugeRegistered = false;
}
