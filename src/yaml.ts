/**
 * Émetteur YAML, sous-ensemble suffisant pour un fichier Compose.
 *
 * La citation est volontairement conservatrice : on laisse une chaîne nue
 * seulement quand elle ne peut être relue que comme elle-même. C'est ici que se
 * cachent les bugs subtils — un port émis en nombre là où Docker attend une
 * chaîne, un `no` relu comme `false`.
 */

export type YamlValue = string | number | boolean | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

// Un scalaire nu ne peut contenir ni espace (donc jamais « : » ni « # » suivis
// d'un espace, les deux seules séquences qui changeraient le sens), ni caractère
// d'indication YAML. Tout le reste — chemins, images taguées, options longues —
// se relit comme lui-même et reste lisible tel quel.
const SAFE = /^[A-Za-z0-9_./-][A-Za-z0-9_./:@+=-]*$/;
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** YAML 1.1 relit `1000:1000` comme un entier en base 60. Le piège des `user:` et des MAC. */
const SEXAGESIMAL = /^[+-]?\d+(:\d+)+$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);

export function emitYaml(root: YamlMap, header: string[] = []): string {
  const out = header.map((comment) => `# ${comment}`);
  if (header.length > 0) out.push("");
  emitMap(root, 0, out);
  return out.join("\n") + "\n";
}

function emitMap(map: YamlMap, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);

  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    const label = `${pad}${scalar(key)}:`;

    if (isMap(value)) {
      if (Object.keys(value).length === 0) out.push(`${label} {}`);
      else {
        out.push(label);
        emitMap(value, depth + 1, out);
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) out.push(`${label} []`);
      else {
        out.push(label);
        emitList(value, depth + 1, out);
      }
      continue;
    }

    out.push(`${label} ${scalar(value)}`);
  }
}

function emitList(list: YamlValue[], depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);

  for (const item of list) {
    if (isMap(item)) {
      const nested: string[] = [];
      emitMap(item, depth + 1, nested);
      // La première ligne porte le tiret, les suivantes gardent leur indentation.
      out.push(`${pad}- ${nested[0]!.trimStart()}`, ...nested.slice(1));
      continue;
    }
    if (Array.isArray(item)) {
      throw new Error("les listes imbriquées ne sont pas émises");
    }
    out.push(`${pad}- ${scalar(item)}`);
  }
}

function scalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`nombre non représentable : ${value}`);
    return String(value);
  }
  if (
    value !== "-" &&
    SAFE.test(value) &&
    !RESERVED.has(value.toLowerCase()) &&
    !NUMERIC.test(value) &&
    !SEXAGESIMAL.test(value)
  ) {
    return value;
  }
  // Les échappements JSON sont un sous-ensemble valide du scalaire YAML entre guillemets.
  return JSON.stringify(value);
}

function isMap(value: YamlValue): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
