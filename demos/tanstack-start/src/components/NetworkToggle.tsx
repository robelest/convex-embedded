import { useNetworkToggle } from "../hooks/useNetworkToggle";
import type { MonitorStatus } from "@robelest/convex-resolve/client";

function statusLabel(status: MonitorStatus): string {
  switch (status.status) {
    case "idle":
      return "Idle";
    case "offline":
      return "Offline";
    case "resolving":
      return `Syncing (${status.progress.completed}/${status.progress.total})`;
    case "resolved":
      return "Synced";
    case "error":
      return "Sync error";
  }
}

function statusColor(status: MonitorStatus): string {
  switch (status.status) {
    case "idle":
      return "bg-gray-400";
    case "offline":
      return "bg-red-500";
    case "resolving":
      return "bg-amber-500 animate-pulse";
    case "resolved":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
  }
}

export function NetworkToggle() {
  const { isOnline, status, toggle } = useNetworkToggle();

  return (
    <div className="flex items-center gap-3">
      {/* Status indicator */}
      <div className="flex items-center gap-1.5">
        <div className={`h-2 w-2 rounded-full ${statusColor(status)}`} />
        <span className="text-xs text-text-secondary font-medium">
          {statusLabel(status)}
        </span>
      </div>

      {/* Toggle switch */}
      <button
        onClick={toggle}
        className={`
          relative inline-flex h-6 w-11 items-center rounded-full
          transition-colors duration-200 ease-in-out
          focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
          ${isOnline ? "bg-accent" : "bg-gray-300"}
        `}
        role="switch"
        aria-checked={isOnline}
        aria-label="Network connection"
        title={isOnline ? "Click to go offline" : "Click to go online"}
      >
        <span
          className={`
            inline-block h-4 w-4 rounded-full bg-white shadow-sm
            transition-transform duration-200 ease-in-out
            ${isOnline ? "translate-x-6" : "translate-x-1"}
          `}
        />
      </button>
      <span className="text-xs font-medium text-text-secondary">
        {isOnline ? "Online" : "Offline"}
      </span>
    </div>
  );
}
