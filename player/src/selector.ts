import { fail } from "./lab";

export interface Selector {
  id: string;
  part: string | null;
}

const SELECTOR = /^([A-Za-z_][\w-]*)(?:\[([^\]]*)\])?$/;

export function parseSelector(text: string): Selector {
  const match = SELECTOR.exec(text.trim());
  if (!match) {
    const owner = /^([A-Za-z_][\w-]*)\./.exec(text.trim())?.[1];
    fail(owner
      ? `"${text}" is not a selector: a dotted name such as a counter is not a part; name the object "${owner}" itself, or one of its parts in brackets like "${owner}[2]"`
      : `"${text}" is not a selector: use an object id like "arr" or a part like "arr[2]"`);
  }
  return { id: match[1]!, part: match[2] ?? null };
}
