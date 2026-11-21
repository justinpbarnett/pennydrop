import type { Challenge } from "./format";

const CHALLENGE_TYPES = ["number", "choice", "click", "order", "match"];

export function challengeProblems(challenge: Challenge): string[] {
  const problems: string[] = [];
  if (challenge.kind !== "predict") problems.push(`challenge kind "${String((challenge as { kind: unknown }).kind)}" is not supported: use "predict"`);
  if (!CHALLENGE_TYPES.includes(challenge.type)) problems.push(`challenge type "${challenge.type}" is unknown: use ${CHALLENGE_TYPES.join(", ")}`);
  if (challenge.type === "number" && typeof challenge.answer !== "number") problems.push('a number challenge needs "answer" as a number');
  if (challenge.type === "choice") {
    if (!Array.isArray(challenge.choices) || challenge.choices.length < 2) problems.push('a choice challenge needs "choices" with at least two entries');
    else if (!challenge.choices.includes(challenge.answer)) problems.push(`choice answer "${challenge.answer}" is not one of the choices`);
  }
  if (challenge.type === "click" && challenge.answer === undefined) problems.push('a click challenge needs "answer" as a selector such as "arr[2]"');
  if (challenge.type === "order" && (!Array.isArray(challenge.choices) || !Array.isArray(challenge.answer))) problems.push('an order challenge needs "choices" and "answer" as lists');
  if (challenge.type === "match" && !Array.isArray(challenge.pairs)) problems.push('a match challenge needs "pairs" as a list of [left, right]');
  return problems;
}

export type Given = number | string | string[] | [string, string][];

function sameList(first: unknown[], second: unknown[]): boolean {
  return first.length === second.length && first.every((value, index) => JSON.stringify(value) === JSON.stringify(second[index]));
}

export function isCorrect(challenge: Challenge, given: Given): boolean {
  switch (challenge.type) {
    case "number":
      return Math.abs(Number(given) - challenge.answer) < 1e-9;
    case "choice":
      return given === challenge.answer;
    case "click":
      return Array.isArray(challenge.answer) ? challenge.answer.includes(given as string) : given === challenge.answer;
    case "order":
      return Array.isArray(given) && sameList(given, challenge.answer);
    case "match": {
      const expected = (challenge.answer ?? challenge.pairs).map((pair) => pair.join("\u0000")).sort();
      const actual = (given as [string, string][]).map((pair) => pair.join("\u0000")).sort();
      return sameList(expected, actual);
    }
  }
}

export function describeAnswer(challenge: Challenge): string {
  if (challenge.type === "match") return (challenge.answer ?? challenge.pairs).map(([left, right]) => `${left} - ${right}`).join(", ");
  const answer = challenge.answer;
  return Array.isArray(answer) ? answer.join(", ") : String(answer);
}
