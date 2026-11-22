import type { Challenge } from "./format";

export type Given = number | string | string[] | [string, string][];

type ChallengeType = Challenge["type"];
type ChallengeOf<T extends ChallengeType> = Extract<Challenge, { type: T }>;

interface ChallengeKind<C extends Challenge> {
  kind: C["kind"];
  prompt: string;
  wordless: boolean;
  problems(challenge: C): string[];
  correct(challenge: C, given: Given): boolean | null;
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
    kind: "predict",
    prompt: "What number do you predict?",
    wordless: false,
    problems: (challenge) => (typeof challenge.answer === "number" ? [] : ['a number challenge needs "answer" as a number']),
    correct: (challenge, given) => Math.abs(Number(given) - challenge.answer) < 1e-9,
    describe: (challenge) => String(challenge.answer),
  },
  choice: {
    kind: "predict",
    prompt: "Pick one.",
    wordless: false,
    problems: (challenge) => {
      if (!Array.isArray(challenge.choices) || challenge.choices.length < 2) return ['a choice challenge needs "choices" with at least two entries'];
      return challenge.choices.includes(challenge.answer) ? [] : [`choice answer "${challenge.answer}" is not one of the choices`];
    },
    correct: (challenge, given) => given === challenge.answer,
    describe: (challenge) => challenge.answer,
  },
  click: {
    kind: "predict",
    prompt: "Click the place on the stage.",
    wordless: true,
    problems: (challenge) => (challenge.answer === undefined ? ['a click challenge needs "answer" as a selector such as "arr[2]"'] : []),
    correct: (challenge, given) => (Array.isArray(challenge.answer) ? challenge.answer.includes(given as string) : given === challenge.answer),
    describe: (challenge) => listed(challenge.answer),
  },
  order: {
    kind: "predict",
    prompt: "Put these in order: tap them one at a time.",
    wordless: false,
    problems: (challenge) => (Array.isArray(challenge.choices) && Array.isArray(challenge.answer) ? [] : ['an order challenge needs "choices" and "answer" as lists']),
    correct: (challenge, given) => Array.isArray(given) && sameList(given, challenge.answer),
    describe: (challenge) => listed(challenge.answer),
  },
  match: {
    kind: "predict",
    prompt: "Match each pair.",
    wordless: false,
    problems: (challenge) => (Array.isArray(challenge.pairs) ? [] : ['a match challenge needs "pairs" as a list of [left, right]']),
    correct: (challenge, given) => sameList(pairKeys(challenge.answer ?? challenge.pairs), pairKeys(given as [string, string][])),
    describe: (challenge) => (challenge.answer ?? challenge.pairs).map(([left, right]) => `${left} - ${right}`).join(", "),
  },
  yesno: {
    kind: "predict",
    prompt: "Does it still work? Yes or no.",
    wordless: true,
    problems: (challenge) => (challenge.answer === "yes" || challenge.answer === "no" ? [] : ['a yesno challenge needs "answer" as "yes" or "no"']),
    correct: (challenge, given) => given === challenge.answer,
    describe: (challenge) => challenge.answer,
  },
  words: {
    kind: "explain",
    prompt: "Say it in your own words, with a because.",
    wordless: true,
    problems: () => [],
    correct: () => null,
    describe: () => "",
  },
};

function kindOf(challenge: Challenge): ChallengeKind<Challenge> | undefined {
  return (CHALLENGES as Record<string, ChallengeKind<Challenge> | undefined>)[challenge.type];
}

export function challengeProblems(challenge: Challenge, reading: boolean): string[] {
  const problems: string[] = [];
  const kind = kindOf(challenge);
  if (!kind) problems.push(`challenge type "${challenge.type}" is unknown: use ${Object.keys(CHALLENGES).join(", ")}`);
  else if (challenge.kind !== kind.kind) problems.push(`a ${challenge.type} challenge has kind "${kind.kind}", not "${String((challenge as { kind: unknown }).kind)}"`);
  else if (!reading && !kind.wordless) problems.push(`a ${challenge.type} challenge needs reading, and this Lesson has "reading": false, for a child who cannot read; use ${wordlessTypes()}: "click" is a tap on an object on the stage, such as "answer": "balls[0]", "yesno" is a tick or a cross, "words" is a spoken answer; let the narration ask the question out loud`);
  else problems.push(...kind.problems(challenge));
  return problems;
}

function wordlessTypes(): string {
  return Object.entries(CHALLENGES).filter(([, kind]) => kind.wordless).map(([type]) => `"type": "${type}"`).join(", ");
}

export function promptFor(challenge: Challenge, say: string | undefined): string {
  return challenge.prompt ?? lastQuestion(say) ?? kindOf(challenge)!.prompt;
}

function lastQuestion(say: string | undefined): string | undefined {
  return say?.split(/(?<=[.!?])\s+/).findLast((sentence) => sentence.endsWith("?"));
}

export function isCorrect(challenge: Challenge, given: Given): boolean | null {
  return kindOf(challenge)!.correct(challenge, given);
}

export function describeAnswer(challenge: Challenge): string {
  return kindOf(challenge)!.describe(challenge);
}
