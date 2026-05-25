import type {
  DevtoolsSnapshot,
  EmbeddedDevtoolsSource,
} from "@/devtools/core/types";

export interface DevtoolsTab {
  id: string;
  name: string;
  countView?: keyof DevtoolsSnapshot;
  count?: (source: EmbeddedDevtoolsSource) => number | undefined;
  mount: (host: HTMLElement, source: EmbeddedDevtoolsSource) => () => void;
}
