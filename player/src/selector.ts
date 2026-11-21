import { fail } from "./lab";

export interface Selector {
  id: string;
  part: string | null;
}

const SELECTOR = /^([A-Za-z_][\w-]*)(?:\[([^\]]*)\])?$/;

export function parseSelector(text: string): Selector {
  const match = SELECTOR.exec(text.trim());
  if (!match) fail(`"${text}" is not a selector: use an object id like "arr" or a part like "arr[2]"`);
  return { id: match[1]!, part: match[2] ?? null };
}
