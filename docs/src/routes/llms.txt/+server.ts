import { sidebar } from "$lib/config/sidebar";

import type { RequestHandler } from "./$types";

const prerender = true;

export const GET: RequestHandler = async () => {
  const files = import.meta.glob("/src/routes/**/+page.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  let output =
    "# convex-embedded\n\n> Embedded Convex runtime with offline-first remote.\n\n";

  for (const group of sidebar) {
    output += `## ${group.label}\n\n`;
    for (const item of group.items) {
      const path = `/src/routes${item.slug}/+page.md`;
      const raw = files[path];
      if (raw) {
        const content = raw.replace(/^---[\s\S]*?---\n*/, "");
        const clean = content
          .replace(/<script[\s\S]*?<\/script>/g, "")
          .replace(/<svelte:head[\s\S]*?<\/svelte:head>/g, "")
          .replace(/<\/?(?:Tabs|TabItem|Card|CardGrid)[^>]*>/g, "")
          .trim();
        output += `### ${item.title}\n\n${clean}\n\n`;
      }
    }
  }

  return new Response(output, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
