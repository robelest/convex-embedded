type AnyHandler = (...args: any[]) => any;

export function createDispatch<THandlers extends Record<string, AnyHandler>>(
  handlers: THandlers,
): <K extends string & keyof THandlers>(
  key: K,
  ...args: Parameters<THandlers[K]>
) => ReturnType<THandlers[K]> {
  const map = new Map<string, AnyHandler>(Object.entries(handlers));
  return ((key: string, ...args: unknown[]) => {
    const handler = map.get(key);
    if (!handler) throw new Error(`Unknown dispatch key: "${key}"`);
    return handler(...args);
  }) as never;
}
