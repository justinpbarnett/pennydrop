import { DO_RULES, SCENE_RULES } from "../src/format";
import { labCatalog } from "../src/lab";
import { allDefinitions } from "../src/registry";
import { relationDocs } from "../src/relation";
import { THEME_IDS } from "../src/theme";
import { verbSummaries } from "../src/verbs";
import { mintedIds, registerAllLabs } from "./load";

await registerAllLabs();
const entries = allDefinitions().map(({ key, def }) => ({ key, id: def.id, title: def.title, ...labCatalog(def), minted: key.startsWith("lab:") && mintedIds.includes(def.id) }));
const labs = entries.filter((entry) => entry.key.startsWith("lab:"));
const primitives = entries.filter((entry) => entry.key.startsWith("primitive:"));

if (!process.argv.includes("--md")) {
  console.log(JSON.stringify({ labs, primitives, scene: SCENE_RULES, relations: relationDocs(), do: DO_RULES, verbs: verbSummaries(), themes: THEME_IDS }, null, 2));
} else {
  const block = (heading: string, list: typeof entries, field: "lab" | "kind") => list.flatMap((entry) => [
    `### ${heading} \`${field}: "${entry.id}"\` - ${entry.title}${entry.wordless ? "" : " (needs reading)"}${entry.minted ? " (minted, not yet promoted)" : ""}`,
    entry.summary,
    "",
    "Spec fields:",
    ...Object.entries(entry.spec).map(([name, text]) => `- \`${name}\`: ${text}`),
    ...(Object.keys(entry.ops).length ? ["", "Operations:", ...Object.entries(entry.ops).map(([name, text]) => `- \`${name}\`: ${text}`)] : []),
    ...(entry.example.length ? ["", "Example:", ...entry.example.map((line) => `    ${line}`)] : []),
    "",
  ]);
  console.log([
    "## Labs",
    "",
    ...block("Lab", labs, "lab"),
    "## Primitives",
    "",
    ...block("Primitive", primitives, "kind"),
    "## The scene list",
    "",
    ...SCENE_RULES.map((line) => `- ${line}`),
    "",
    "## Placing objects",
    "",
    ...relationDocs().map((line) => `- ${line}`),
    "",
    "## The do list",
    "",
    ...DO_RULES.map((line) => `- ${line}`),
    "",
    "## Generic verbs",
    "",
    ...verbSummaries().map((line) => `- ${line}`),
    "",
    `Themes: ${THEME_IDS.join(", ")}`,
  ].join("\n"));
}
