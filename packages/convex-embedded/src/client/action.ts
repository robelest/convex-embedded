import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

import type { EffectDescriptor } from "@/client/optimistic/derive";

export type OptimisticEffectInput =
  | EffectDescriptor
  | OptimisticEffectInput[]
  | null
  | undefined;

export interface OptimisticActionContext<TArgs> {
  args: TArgs;
}

export interface OptimisticActionInput<
  Mutation extends FunctionReference<"mutation">,
> {
  client: ConvexClient;
  mutation: Mutation;
  onMutate?: (
    ctx: OptimisticActionContext<Mutation["_args"]>,
  ) => OptimisticEffectInput;
}

export type OptimisticAction<Mutation extends FunctionReference<"mutation">> = ((
  args: Mutation["_args"],
) => Promise<Awaited<Mutation["_returnType"]>>) & {
  readonly mutation: Mutation;
};

interface ClientWithOptimistic {
  applyOptimisticEffects?: (effects: ReadonlyArray<EffectDescriptor>) => void;
  mutation: ConvexClient["mutation"];
}

function flattenEffects(input: OptimisticEffectInput): EffectDescriptor[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    const out: EffectDescriptor[] = [];
    for (const item of input) out.push(...flattenEffects(item));
    return out;
  }
  return [input];
}

export function createOptimisticAction<
  Mutation extends FunctionReference<"mutation">,
>(input: OptimisticActionInput<Mutation>): OptimisticAction<Mutation> {
  const client = input.client as unknown as ClientWithOptimistic;

  const callable = ((args: Mutation["_args"]) => {
    if (input.onMutate) {
      const effects = flattenEffects(input.onMutate({ args }));
      if (effects.length > 0 && typeof client.applyOptimisticEffects === "function") {
        client.applyOptimisticEffects(effects);
      }
    }
    return client.mutation(input.mutation, args);
  }) as OptimisticAction<Mutation>;
  Object.defineProperty(callable, "mutation", {
    value: input.mutation,
    enumerable: false,
  });
  return callable;
}
