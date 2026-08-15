// Resolve a workflow `agentType` to its system prompt (and optional model) from
// OMP agent definitions. Project scope (`.omp/agents`) takes precedence over the
// active user's default agent directory (`~/.omp/agent/agents`).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";

const cache = new Map();

async function tryRead(path) {
  try {
    return { path, body: await readFile(path, "utf8") };
  } catch {
    return null;
  }
}

async function findUp(startDir, rel) {
  let dir = startDir;
  for (;;) {
    const found = await tryRead(join(dir, rel));
    if (found) return found;
    const parent = parse(dir).dir;
    if (!parent || parent === dir) return null;
    dir = parent;
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * `model` is the definition's frontmatter value; pass it through resolveModel()
 * before use.
 */
export async function loadAgentType(name, cwd = process.cwd()) {
  if (!name) return null;
  const key = `${cwd}::${name}`;
  if (cache.has(key)) return cache.get(key);

  const rel = join(".omp", "agents", `${name}.md`);
  const found =
    (await findUp(cwd, rel)) ??
    (await tryRead(join(homedir(), ".omp", "agent", "agents", `${name}.md`)));

  let result = null;
  if (found) {
    const { meta, body } = parseFrontmatter(found.body);
    result = {
      systemPrompt: body.trim(),
      model: meta.model || undefined,
      source: found.path,
    };
  }
  cache.set(key, result);
  return result;
}
