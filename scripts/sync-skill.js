#!/usr/bin/env node
// Sync this repo's skill surface to OMP's default user skill directory.
//
//   npm run sync-skill            # repo → ~/.omp/agent/skills/codex-workflows
//
// Copies the canonical skill plus references/ + examples/ + runner/, excluding
// local run artifacts (but keeping the bundled demo's committed journal). The
// destination is replaced wholesale, so renames/deletions propagate too.

import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = process.argv[2] || join(homedir(), ".omp", "agent", "skills", "codex-workflows");

// Local artifacts that must not ship: OS noise, generated viewer pages, and
// run journals — EXCEPT the bundled demo's committed journal, which is the
// no-Codex-required showcase.
const KEEP_JOURNAL = join(SRC, "examples", "incident-demo", ".workflow-journal");
const skip = (p) => {
  const b = basename(p);
  if (b === ".DS_Store" || b === "node_modules") return true;
  if (b.endsWith(".run.html")) return true;
  if (b === ".workflow-journal" && p !== KEEP_JOURNAL) return true;
  return false;
};
const filter = (s) => !skip(s);

const SKILL = join(SRC, "skills", "codex-workflows", "SKILL.md");
if (!existsSync(SKILL)) {
  console.error(`sync-skill: ${SRC} does not contain skills/codex-workflows/SKILL.md`);
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SKILL, join(DEST, "SKILL.md"));
for (const dir of ["references", "examples", "runner"]) {
  cpSync(join(SRC, dir), join(DEST, dir), { recursive: true, filter });
}

const ver = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
console.log(`synced skill (v${ver}) → ${DEST}`);
console.log(`  SKILL.md + references${sep} + examples${sep} + runner${sep}`);
console.log("  (excluded: .DS_Store, node_modules, *.run.html, local .workflow-journal dirs)");
