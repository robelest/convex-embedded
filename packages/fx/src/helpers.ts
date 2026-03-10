/**
 * Run an async function, log errors, and swallow them.
 * Replaces the fire-and-forget boilerplate.
 */
export function detach(fn: () => Promise<unknown>, label: string): void {
  fn().catch((err) => {
    console.error(label, err);
  });
}
