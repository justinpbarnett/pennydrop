import * as lab from "./lab";
import { type LabModule, registerModules } from "./registry";
import * as textMetrics from "./text-metrics";

export const SHARED_MODULES: Record<string, object> = { lab, "text-metrics": textMetrics };
export const SHARED_GLOBAL = "__pennydropShared";

export interface MintedListing {
  id: string;
  url: string;
}

export function installShared(): void {
  (globalThis as Record<string, unknown>)[SHARED_GLOBAL] = SHARED_MODULES;
}

export async function registerMinted(listing: MintedListing[], load: (url: string) => Promise<LabModule>): Promise<string[]> {
  installShared();
  const modules: Record<string, LabModule> = {};
  for (const { id, url } of listing) modules[`minted:${id}`] = await load(url);
  registerModules(modules);
  return listing.map(({ id }) => id);
}

export async function loadMintedLabs(): Promise<void> {
  const response = await fetch("/api/minted-labs").catch(() => null);
  if (!response?.ok) return;
  const listing = (await response.json()) as MintedListing[];
  await registerMinted(listing, (url) => import(/* @vite-ignore */ url) as Promise<LabModule>);
}
