import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { generateSuite, getCallCount } from "./evaluate.js";
import { diffPrompts } from "./diff.js";

const RUNS = parseInt(process.env.PW_RUNS || "10", 10);
const BASE = process.env.PW_BASE_REF || "origin/main";

function sh(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }

// Prompt files are the .txt files in the repo root, plus the demo file below.
const changed = sh(`git diff --name-only ${BASE}...HEAD`)
  .split("\n")
  .filter((f) => f.endsWith(".txt") && !f.includes("/"));

if (!changed.length) {
  console.log("No prompt files changed. Nothing to check.");
  writeFileSync("gate-comment.md", "### Prompt Whisperer\nNo prompt files changed in this PR.\n");
  process.exit(0);
}

let comment = "### Prompt Whisperer gate\n\n";
let failed = false;

for (const file of changed) {
  const name = path.basename(file, ".txt");
  const newPrompt = readFileSync(file, "utf8");
  let oldPrompt;
  try { oldPrompt = sh(`git show ${BASE}:${file}`); }
  catch { comment += `**${file}**: new file, no earlier version to compare. Skipped.\n\n`; continue; }

  // Use a saved suite if one is in the repo, otherwise generate one from the OLD prompt
  // so the pull request cannot shape its own test.
  const suitePath = `suite-${name}.json`;
  let suite;
  let generated = false;
  if (existsSync(suitePath)) {
    suite = JSON.parse(readFileSync(suitePath, "utf8"));
  } else {
    suite = await generateSuite(oldPrompt);
    writeFileSync(suitePath, JSON.stringify(suite, null, 2));
    generated = true;
  }

  const r = await diffPrompts(oldPrompt, newPrompt, suite, RUNS);
  const icon = { regression_confirmed: "FAIL", possible_regression: "WARN", no_regression: "PASS" }[r.verdict];
  if (r.verdict === "regression_confirmed") failed = true;

  comment += `**${file}**: ${icon}\n\n`;
  comment += `${r.summary}\n\n`;
  comment += `| | Score | 95% range |\n|---|---|---|\n`;
  comment += `| Old | ${r.old_trust_score} | ${r.old_score_low} to ${r.old_score_high} |\n`;
  comment += `| New | ${r.new_trust_score} | ${r.new_score_low} to ${r.new_score_high} |\n\n`;
  if (r.regressions.length) {
    comment += `Weakened:\n`;
    for (const x of r.regressions) comment += `- ${x.attack_type} (${x.severity}): ${x.explanation}\n`;
    comment += `\n`;
  }
  if (r.verdict === "possible_regression") {
    comment += `The score dropped but the ranges overlap, so this is not confirmed at ${RUNS} runs per attack. Review the wording change.\n\n`;
  }
  if (generated) {
    comment += `_A new attack suite was generated for this file (${suitePath}). It is not saved in the repo yet._\n\n`;
  }
}

comment += `_${RUNS} runs per attack, ${getCallCount()} API calls._\n`;
writeFileSync("gate-comment.md", comment);
console.log(comment);
process.exit(failed ? 1 : 0);
