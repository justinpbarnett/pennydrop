import type { Challenge } from "./format";

export type Given = number | string | string[] | [string, string][];

type ChallengeType = Challenge["type"];
type ChallengeOf<T extends ChallengeType> = Extract<Challenge, { type: T }>;

interface ChallengeKind<C extends Challenge> {
  prompt: string;
  problems(challenge: C): string[];
  correct(challenge: C, given: Given): boolean;
  describe(challenge: C): string;
}

function sameList(first: unknown[], second: unknown[]): boolean {
  return first.length === second.length && first.every((value, index) => JSON.stringify(value) === JSON.stringify(second[index]));
}

function listed(answer: unknown): string {
  return Array.isArray(answer) ? answer.join(", ") : String(answer);
}

function pairKeys(pairs: [string, string][]): string[] {
  return pairs.map((pair) => pair.join("\u0000")).sort();
}

const CHALLENGES: { [T in ChallengeType]: ChallengeKind<ChallengeOf<T>> } = {
  number: {
    prompt: "What number do you predict?",
    problems: (challenge) => (typeof challenge.answer === "number" ? [] : ['a number challenge needs "answer" as a number']),
    correct: (challenge, given) => Math.abs(Number(given) - challenge.answer) < 1e-9,
    describe: (challenge) => String(challenge.answer),
  },
  choice: {
    prompt: "Pick one.",
    problems: (challenge) => {
      if (!Array.isArray(challenge.choices) || challenge.choices.length < 2) return ['a choice challenge needs "choices" with at least two entries'];
      return challenge.choices.includes(challenge.answer) ? [] : [`choice answer "${challenge.answer}" is not one of the choices`];
    },
    correct: (challenge, given) => given === challenge.answer,
    describe: (challenge) => challenge.answer,
  },
  click: {
    prompt: "Click the place on the stage.",
    problems: (challenge) => (challenge.answer === undefined ? ['a click challenge needs "answer" as a selector such as "arr[2]"'] : []),
    correct: (challenge, given) => (Array.isArray(challenge.answer) ? challenge.answer.includes(given as string) : given === challenge.answer),
    describe: (challenge) => listed(challenge.answer),
  },
  order: {
    prompt: "Put these in order: tap them one at a time.",
    problems: (challenge) => (Array.isArray(challenge.choices) && Array.isArray(challenge.answer) ? [] : ['an order challenge needs "choices" and "answer" as lists']),
    correct: (challenge, given) => Array.isArray(given) && sameList(given, challenge.answer),
    describe: (challenge) => listed(challenge.answer),
  },
  match: {
    prompt: "Match each pair.",
    problems: (challenge) => (Array.isArray(challenge.pairs) ? [] : ['a match challenge needs "pairs" as a list of [left, right]']),
    correct: (challenge, given) => sameList(pairKeys(challenge.answer ?? challenge.pairs), pairKeys(given as [string, string][])),
    describe: (challenge) => (challenge.answer ?? challenge.pairs).map(([left, right]) => `${left} - ${right}`).join(", "),
  },
};

function kindOf(challenge: Challenge): ChallengeKind<Challenge> | undefined {
  return (CHALLENGES as Record<string, ChallengeKind<Challenge> | undefined>)[challenge.type];
}

export function challengeProblems(challenge: Challenge): string[] {
  const problems: string[] = [];
  if (challenge.kind !== "predict") problems.push(`challenge kind "${String((challenge as { kind: unknown }).kind)}" is not supported: use "predict"`);
  const kind = kindOf(challenge);
  if (kind) problems.push(...kind.problems(challenge));
  else problems.push(`challenge type "${challenge.type}" is unknown: use ${Object.keys(CHALLENGES).join(", ")}`);
  return problems;
}

export function defaultPrompt(challenge: Challenge): string {
  return kindOf(challenge)!.prompt;
}

export function isCorrect(challenge: Challenge, given: Given): boolean {
  return kindOf(challenge)!.correct(challenge, given);
}

export function describeAnswer(challenge: Challenge): string {
  return kindOf(challenge)!.describe(challenge);
}
