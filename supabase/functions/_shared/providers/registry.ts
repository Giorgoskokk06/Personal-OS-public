import { googleProvider } from "./google.ts";
import { openRouterProvider } from "./openrouter.ts";
import { nvidiaProvider } from "./nvidia.ts";
import type { StructuredProvider } from "./types.ts";

// Personal OS v1.3 production inference plane: exactly three active adapters.
const providers = new Map<string, StructuredProvider>([
  [googleProvider.id, googleProvider],
  [openRouterProvider.id, openRouterProvider],
  [nvidiaProvider.id, nvidiaProvider],
]);

export function getStructuredProvider(id: string): StructuredProvider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`AI provider adapter '${id}' is not installed.`);
  return provider;
}

export function hasStructuredProvider(id: string): boolean {
  return providers.has(id);
}
