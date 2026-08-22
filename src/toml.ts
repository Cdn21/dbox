/**
 * Parseur TOML, sous-ensemble assumé.
 *
 * Supporté : commentaires `#`, en-têtes de table `[a.b]`, clés nues,
 * chaînes de base `"…"`, entiers, booléens.
 *
 * Tout le reste est refusé avec un message et un numéro de ligne. Rien n'est
 * ignoré en silence : une clé mal orthographiée doit exploser, pas disparaître.
 */

export class TomlError extends Error {
  // Champ déclaré puis assigné : Node exécute le TypeScript en effaçant les
  // types, sans les générer — les propriétés de constructeur n'y passent pas.
  readonly line: number;

  constructor(message: string, line: number) {
    super(`ligne ${line} : ${message}`);
    this.name = "TomlError";
    this.line = line;
  }
}

export type TomlPrimitive = string | number | boolean;
export type TomlTable = { [key: string]: TomlPrimitive | TomlTable };

export interface TomlDocument {
  data: TomlTable;
  /** Chemin pointé (« targets.dev.port ») → numéro de ligne, pour situer les erreurs. */
  lines: Map<string, number>;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const INTEGER = /^[+-]?\d+$/;

export function parseToml(src: string): TomlDocument {
  const data: TomlTable = {};
  const lines = new Map<string, number>();
  const declaredTables = new Set<string>();
  let path: string[] = [];

  src.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) return;

    if (text.startsWith("[")) {
      path = readTableHeader(text, line, data, lines, declaredTables);
      return;
    }

    readAssignment(text, line, path, data, lines);
  });

  return { data, lines };
}

function readTableHeader(
  text: string,
  line: number,
  data: TomlTable,
  lines: Map<string, number>,
  declaredTables: Set<string>,
): string[] {
  if (text.startsWith("[[")) {
    throw new TomlError("les tableaux de tables ([[…]]) ne sont pas supportés", line);
  }
  const close = text.indexOf("]");
  if (close === -1) throw new TomlError("en-tête de table non fermé", line);

  const rest = text.slice(close + 1).trim();
  if (rest !== "" && !rest.startsWith("#")) {
    throw new TomlError(`« ${rest} » de trop après l'en-tête de table`, line);
  }

  const inner = text.slice(1, close).trim();
  if (inner === "") throw new TomlError("en-tête de table vide", line);

  const parts = inner.split(".").map((part) => part.trim());
  for (const part of parts) {
    if (!BARE_KEY.test(part)) {
      throw new TomlError(`« ${part} » n'est pas un nom de table valide`, line);
    }
  }

  const dotted = parts.join(".");
  if (declaredTables.has(dotted)) {
    throw new TomlError(`la table « ${dotted} » est déclarée deux fois`, line);
  }
  declaredTables.add(dotted);

  descend(data, parts, line);
  lines.set(dotted, line);
  return parts;
}

function readAssignment(
  text: string,
  line: number,
  path: string[],
  data: TomlTable,
  lines: Map<string, number>,
): void {
  const equals = text.indexOf("=");
  if (equals === -1) {
    throw new TomlError(`« ${text} » n'est ni une table ni une affectation`, line);
  }

  const key = text.slice(0, equals).trim();
  if (!BARE_KEY.test(key)) {
    if (key.includes(".")) {
      throw new TomlError(`les clés pointées (« ${key} ») ne sont pas supportées`, line);
    }
    if (key.startsWith('"') || key.startsWith("'")) {
      throw new TomlError(`les clés entre guillemets (« ${key} ») ne sont pas supportées`, line);
    }
    throw new TomlError(`« ${key} » n'est pas un nom de clé valide`, line);
  }

  const value = readValue(text.slice(equals + 1).trim(), line);
  const table = descend(data, path, line);
  if (Object.hasOwn(table, key)) {
    const dotted = [...path, key].join(".");
    throw new TomlError(`la clé « ${dotted} » est définie deux fois`, line);
  }
  table[key] = value;
  lines.set([...path, key].join("."), line);
}

function readValue(raw: string, line: number): TomlPrimitive {
  if (raw.startsWith('"')) {
    const { value, length } = readBasicString(raw, line);
    const rest = raw.slice(length).trim();
    if (rest !== "" && !rest.startsWith("#")) {
      throw new TomlError(`« ${rest} » de trop après la valeur`, line);
    }
    return value;
  }

  const hash = raw.indexOf("#");
  const token = (hash === -1 ? raw : raw.slice(0, hash)).trim();

  if (token === "") throw new TomlError("valeur manquante", line);
  if (token === "true") return true;
  if (token === "false") return false;

  if (INTEGER.test(token)) {
    const parsed = Number(token);
    if (!Number.isSafeInteger(parsed)) {
      throw new TomlError(`l'entier « ${token} » est hors des bornes représentables`, line);
    }
    return parsed;
  }

  if (token.startsWith("'")) {
    throw new TomlError("les chaînes littérales (') ne sont pas supportées, utilise \"…\"", line);
  }
  if (token.startsWith("[")) {
    throw new TomlError("les tableaux ne sont pas supportés", line);
  }
  if (token.startsWith("{")) {
    throw new TomlError("les tables en ligne ne sont pas supportées", line);
  }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+[eE])/.test(token)) {
    throw new TomlError(`les flottants (« ${token} ») ne sont pas supportés`, line);
  }
  throw new TomlError(`valeur non supportée : « ${token} » — une chaîne doit être entre guillemets`, line);
}

function readBasicString(raw: string, line: number): { value: string; length: number } {
  const escapes: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r" };
  let value = "";

  for (let i = 1; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"') return { value, length: i + 1 };
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = raw[i + 1];
    if (escaped === undefined || !Object.hasOwn(escapes, escaped)) {
      throw new TomlError(`échappement « \\${escaped ?? ""} » non supporté`, line);
    }
    value += escapes[escaped];
    i++;
  }

  throw new TomlError("chaîne non terminée", line);
}

/** Descend (en les créant) les tables du chemin, et renvoie la dernière. */
function descend(root: TomlTable, path: string[], line: number): TomlTable {
  let table = root;
  const walked: string[] = [];

  for (const part of path) {
    walked.push(part);
    const existing = table[part];
    if (existing === undefined) {
      const created: TomlTable = {};
      table[part] = created;
      table = created;
      continue;
    }
    if (typeof existing !== "object") {
      throw new TomlError(`« ${walked.join(".")} » est une valeur, pas une table`, line);
    }
    table = existing;
  }

  return table;
}
