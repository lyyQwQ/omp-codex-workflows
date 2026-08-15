// Resolve workflow model ids against the models exposed by the local Codex
// app-server.

export function modelId(m) {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.id ?? m.slug ?? m.model ?? m.name ?? null;
  return null;
}

// The API's family alias is not necessarily listed by Codex model/list. Resolve
// it to the explicit catalog id so `--model gpt-5.6` works with the App Server.
const MODEL_ALIASES = {
  "gpt-5.6": "gpt-5.6-sol",
};


export function resolveModel(requested, available = [], log = () => {}) {
  if (!requested || /^(inherit|default)$/i.test(requested)) return undefined;

  // Preserve an exact catalog id before expanding API aliases. This also keeps
  // the resolver compatible if a future catalog exposes the bare family alias.
  if (available.includes(requested)) return requested;

  const alias = MODEL_ALIASES[String(requested).toLowerCase()];
  if (alias && (!available.length || available.includes(alias))) {
    log(`model: '${requested}' → '${alias}'`);
    return alias;
  }

  if (!available.length) return requested;

  log(`model: '${requested}' not exposed by Codex → using config default (have: ${available.join(", ")})`);
  return undefined;
}


// Pick the latest frontier model from a `model/list` result: the newest,
// strongest general model. Excludes -mini/-spark variants and hidden models;
// ranks by version number, then GPT-5.6 family tier (Sol > Terra > Luna), then
// the catalog's default flag and the shorter (base) id.
export function pickFrontier(models = []) {
  const id = (m) => (typeof m === "string" ? m : m?.id ?? m?.model ?? m?.slug ?? m?.name);
  const versionParts = (s) => {
    const mt = String(s).match(/(\d+(?:\.\d+)?)/);
    return mt ? mt[1].split(".").map(Number) : [-1];
  };
  const compareVersionDesc = (left, right) => {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const delta = (b[i] ?? 0) - (a[i] ?? 0);
      if (delta) return delta;
    }
    return 0;
  };
  const strength = (s) => {
    const value = String(s).toLowerCase();
    if (/-sol$/.test(value)) return 3;
    if (/-terra$/.test(value)) return 2;
    if (/-luna$/.test(value)) return 1;
    return 3; // unsuffixed models and aliases are flagship/general models
  };
  const eligible = models
    .map((m) => ({
      id: id(m),
      isDefault: typeof m === "object" && !!m?.isDefault,
      hidden: typeof m === "object" && !!m?.hidden,
    }))
    .filter((m) => m.id && !m.hidden && !/(mini|spark)/i.test(m.id));
  if (!eligible.length) return undefined;
  eligible.sort(
    (a, b) =>
      compareVersionDesc(a.id, b.id) ||
      strength(b.id) - strength(a.id) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.id.length - b.id.length,
  );
  return eligible[0].id;
}
