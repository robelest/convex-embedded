export interface SidebarItem {
  title: string;
  slug: string;
}

export interface SidebarGroup {
  label: string;
  items: SidebarItem[];
}

export const sidebar: SidebarGroup[] = [
  {
    label: "Getting Started",
    items: [
      { title: "Introduction", slug: "/getting-started/introduction" },
      { title: "Installation", slug: "/getting-started/installation" },
      { title: "Quick Start", slug: "/getting-started/quick-start" },
    ],
  },
  {
    label: "Guides",
    items: [
      { title: "Browser Integration", slug: "/guides/browser" },
      { title: "Embedded Tables & Fields", slug: "/guides/embedded-tables" },
      { title: "Local vs Remote Execution", slug: "/guides/local-vs-remote" },
      { title: "Auth & Identity", slug: "/guides/auth" },
      { title: "Cross-Tab Sync", slug: "/guides/cross-tab" },
      { title: "Remote Configuration", slug: "/guides/sync-config" },
    ],
  },
  {
    label: "API Reference",
    items: [
      { title: "Browser API", slug: "/api/browser" },
      { title: "Client API", slug: "/api/client" },
      { title: "Server API", slug: "/api/server" },
      { title: "CRDT Schema", slug: "/api/crdt" },
      { title: "Test Utilities", slug: "/api/test" },
      { title: "Configuration", slug: "/reference/config" },
      { title: "Error Handling", slug: "/reference/errors" },
    ],
  },
  {
    label: "Reference",
    items: [
      { title: "Architecture", slug: "/concepts/architecture" },
      { title: "Persistence", slug: "/concepts/persistence" },
      { title: "Offline Reconciliation", slug: "/concepts/offline-sync" },
      { title: "Embedded Runtime", slug: "/concepts/embedded-runtime" },
      { title: "CRDT Fields", slug: "/concepts/crdt-fields" },
      { title: "Local Search", slug: "/concepts/local-search" },
      { title: "Vector Search", slug: "/concepts/vector-search" },
      { title: "Migration Guide", slug: "/reference/migration" },
      { title: "Troubleshooting", slug: "/reference/troubleshooting" },
    ],
  },
];

