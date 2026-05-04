import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";

export interface BufferedSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  startMs: number;
  durMs: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error" | "unset";
  error?: string;
  events: Array<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
}

export interface BufferingTracingHandle {
  getSpans(): BufferedSpan[];
  clearSpans(): void;
  subscribe(callback: () => void): () => void;
  close(): Promise<void>;
}

type Listener = () => void;

export class BufferingSpanProcessor implements SpanProcessor {
  private readonly _spans: BufferedSpan[] = [];
  private readonly _listeners = new Set<Listener>();
  private _notifyHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly _capacity: number) {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if (this._spans.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[tracing] BufferingSpanProcessor.onEnd first span: ${span.name}`);
    }
    const ctx = span.spanContext();
    const startMs = hrTimeToMs(span.startTime);
    const endMs = hrTimeToMs(span.endTime);
    const status = span.status.code;
    const buffered: BufferedSpan = {
      name: span.name,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      traceId: ctx.traceId,
      startMs,
      durMs: Math.max(0, endMs - startMs),
      attributes: { ...span.attributes },
      status:
        status === SpanStatusCode.OK
          ? "ok"
          : status === SpanStatusCode.ERROR
            ? "error"
            : "unset",
      error: status === SpanStatusCode.ERROR ? span.status.message : undefined,
      events: span.events.map((event) => ({
        name: event.name,
        timeMs: hrTimeToMs(event.time),
        attributes: event.attributes
          ? { ...event.attributes }
          : undefined,
      })),
    };
    this._spans.push(buffered);
    if (this._spans.length > this._capacity) {
      this._spans.splice(0, this._spans.length - this._capacity);
    }
    this._scheduleNotify();
  }

  shutdown(): Promise<void> {
    if (this._notifyHandle !== null) {
      clearTimeout(this._notifyHandle);
      this._notifyHandle = null;
    }
    this._listeners.clear();
    this._spans.length = 0;
    return Promise.resolve();
  }

  getSpans(): BufferedSpan[] {
    return this._spans.slice();
  }

  clearSpans(): void {
    this._spans.length = 0;
    this._scheduleNotify();
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _scheduleNotify(): void {
    if (this._notifyHandle !== null) return;
    this._notifyHandle = setTimeout(() => {
      this._notifyHandle = null;
      for (const listener of this._listeners) {
        try {
          listener();
        } catch {
          // ignore listener errors
        }
      }
    }, 50);
  }
}

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}
