import * as Network from "expo-network";

import type { ConnectivityAdapter } from "@/runtime/platform";

export function createExpoConnectivityAdapter(): ConnectivityAdapter {
  let isOnline = true;
  let closed = false;
  const onlineListeners = new Set<() => void>();
  const offlineListeners = new Set<() => void>();

  const applyState = (next: boolean) => {
    if (closed) {
      return;
    }
    if (next === isOnline) {
      return;
    }
    isOnline = next;
    const listeners = next ? onlineListeners : offlineListeners;
    for (const listener of listeners) {
      listener();
    }
  };

  void Network.getNetworkStateAsync().then((state) => {
    applyState(state.isInternetReachable ?? state.isConnected ?? false);
  });

  const subscription = Network.addNetworkStateListener((state) => {
    applyState(state.isInternetReachable ?? state.isConnected ?? false);
  });

  return {
    isOnline() {
      return isOnline;
    },
    onOnline(callback) {
      onlineListeners.add(callback);
      return () => {
        onlineListeners.delete(callback);
      };
    },
    onOffline(callback) {
      offlineListeners.add(callback);
      return () => {
        offlineListeners.delete(callback);
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      subscription.remove();
      onlineListeners.clear();
      offlineListeners.clear();
    },
  };
}
