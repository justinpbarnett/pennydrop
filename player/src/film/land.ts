let rings: number[][][] = [];

export async function loadLand(): Promise<void> {
  const response = await fetch("/api/land").catch(() => null);
  if (!response?.ok) return;
  rings = ((await response.json()) as { rings: number[][][] }).rings;
}

export function landRings(): number[][][] {
  if (rings.length === 0) throw new Error("the map piece needs the land coastlines; run pd film render, which caches them with ensure_land");
  return rings;
}
