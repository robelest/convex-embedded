import { useState, useRef, useEffect, useCallback } from "react";
import { ConvexClient } from "convex/browser";
import { monitor } from "@robelest/convex-resolve/client";
import type { MonitorStatus, MonitorInstance } from "@robelest/convex-resolve/client";
import { api } from "@convex/_generated/api";
import { useRemoteUrl } from "../router";

/**
 * Manages the remote Convex connection and the convex-resolve monitor.
 *
 * - Toggle OFF: closes the remote ConvexClient (drops WebSocket),
 *   stops the monitor. Local embedded runtime keeps working.
 * - Toggle ON: creates a fresh ConvexClient, creates a fresh monitor,
 *   triggers resolve to sync CRDT diffs.
 */
export function useNetworkToggle() {
  const remoteUrl = useRemoteUrl();
  const [isOnline, setIsOnline] = useState(true);
  const [status, setStatus] = useState<MonitorStatus>({ status: "idle" });

  const remoteClientRef = useRef<ConvexClient | null>(null);
  const monitorRef = useRef<MonitorInstance | null>(null);

  // Bootstrap: create the initial remote client + monitor
  useEffect(() => {
    const client = new ConvexClient(remoteUrl);
    remoteClientRef.current = client;

    const m = monitor.create({
      remoteClient: client,
      tables: {
        tasks: { resolve: api.tasks.resolveTask },
      },
    });

    const unsub = m.on("change", (s) => setStatus(s));
    m.start();
    monitorRef.current = m;

    return () => {
      unsub();
      m.stop();
      client.close();
    };
  }, [remoteUrl]);

  const goOffline = useCallback(() => {
    // Stop the monitor (aborts in-flight resolve)
    monitorRef.current?.stop();
    monitorRef.current = null;

    // Actually close the remote WebSocket connection
    remoteClientRef.current?.close();
    remoteClientRef.current = null;

    setIsOnline(false);
    setStatus({ status: "offline" });
  }, []);

  const goOnline = useCallback(() => {
    // Create a fresh remote client
    const client = new ConvexClient(remoteUrl);
    remoteClientRef.current = client;

    // Create a fresh monitor wired to the new client
    const m = monitor.create({
      remoteClient: client,
      tables: {
        tasks: { resolve: api.tasks.resolveTask },
      },
    });

    m.on("change", (s) => setStatus(s));
    m.start();
    monitorRef.current = m;

    setIsOnline(true);
  }, [remoteUrl]);

  const toggle = useCallback(() => {
    if (isOnline) {
      goOffline();
    } else {
      goOnline();
    }
  }, [isOnline, goOffline, goOnline]);

  return { isOnline, status, toggle, goOffline, goOnline };
}
