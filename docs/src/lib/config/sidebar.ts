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

/** Flat list of all items in sidebar order, for prev/next navigation */
export const allPages = sidebar.flatMap((group) => group.items);

export function getPrevNext(currentSlug: string) {
  const normalized = currentSlug.replace(/\/$/, "");
  const idx = allPages.findIndex((p) => p.slug === normalized);
  return {
    prev: idx > 0 ? allPages[idx - 1] : null,
    next: idx < allPages.length - 1 ? allPages[idx + 1] : null,
  };
}
