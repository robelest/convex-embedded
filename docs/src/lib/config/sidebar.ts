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
    label: "Core Concepts",
    items: [
      { title: "Architecture", slug: "/concepts/architecture" },
      { title: "Embedded Runtime", slug: "/concepts/embedded-runtime" },
      { title: "CRDT Fields", slug: "/concepts/crdt-fields" },
      { title: "Offline Reconciliation", slug: "/concepts/offline-sync" },
      { title: "Persistence", slug: "/concepts/persistence" },
    ],
  },
  {
    label: "API Reference",
    items: [
      { title: "Browser API", slug: "/api/browser" },
      { title: "Server API", slug: "/api/server" },
      { title: "CRDT Schema", slug: "/api/crdt" },
      { title: "Client Internals", slug: "/api/client" },
      { title: "Test Utilities", slug: "/api/test" },
    ],
  },
  {
    label: "Guides",
    items: [
      { title: "React Integration", slug: "/guides/react" },
      { title: "Svelte Integration", slug: "/guides/svelte" },
      { title: "Remote Configuration", slug: "/guides/sync-config" },
      { title: "Auth & Identity", slug: "/guides/auth" },
      { title: "Cross-Tab Sync", slug: "/guides/cross-tab" },
    ],
  },
  {
    label: "Reference",
    items: [
      { title: "Configuration", slug: "/reference/config" },
      { title: "Error Handling", slug: "/reference/errors" },
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
