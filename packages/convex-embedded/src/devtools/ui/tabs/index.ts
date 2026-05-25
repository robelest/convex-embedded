import type { DevtoolsTab } from "@/devtools/ui/tab";
import { activityTab } from "@/devtools/ui/tabs/activity";
import { dataTab } from "@/devtools/ui/tabs/data";
import { functionsTab } from "@/devtools/ui/tabs/functions";
import { logsTab } from "@/devtools/ui/tabs/logs";
import { performanceTab } from "@/devtools/ui/tabs/performance";
import { settingsTab } from "@/devtools/ui/tabs/settings";
import { subscriptionsTab } from "@/devtools/ui/tabs/subscriptions";
import { syncTab } from "@/devtools/ui/tabs/sync";

export const tabs: DevtoolsTab[] = [
  activityTab,
  subscriptionsTab,
  performanceTab,
  logsTab,
  dataTab,
  functionsTab,
  syncTab,
  settingsTab,
];
