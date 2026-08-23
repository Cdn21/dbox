import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToml, TomlError } from "../src/toml.ts";

function refuses(source: string, fragment: string, line: number): void {
  let error: unknown;
  try {
    parseToml(source);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof TomlError, `aucune TomlError levée pour ${JSON.stringify(source)}`);
  assert.match(error.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(error.line, line, `attendu ligne ${line}, obtenu ${error.line}`);
}

describe("constructions supportées", () => {
  it("lit clés nues, chaînes, entiers et booléens", () => {
    const { data } = parseToml(`
name = "budget"
port = 5178
signed = -12
enabled = true
disabled = false
`);
    assert.deepEqual(data, {
      name: "budget",
      port: 5178,
      signed: -12,
      enabled: true,
      disabled: false,
    });
  });

  it("lit les tables imbriquées", () => {
    const { data } = parseToml(`
name = "budget"

[targets.dev]
port = 5178

[targets.prod]
port = 8080
`);
    assert.deepEqual(data, {
      name: "budget",
      targets: { dev: { port: 5178 }, prod: { port: 8080 } },
    });
  });

  it("ignore commentaires et lignes vides, y compris en fin de ligne", () => {
    const { data } = parseToml(`
# un commentaire

[targets.dev]   # après une table
port = 5178     # après un entier
command = "npm run dev"  # après une chaîne
`);
    assert.deepEqual(data, { targets: { dev: { port: 5178, command: "npm run dev" } } });
  });

  it("ne coupe pas sur un # à l'intérieur d'une chaîne", () => {
    const { data } = parseToml(`command = "echo '#1'"`);
    assert.equal(data["command"], "echo '#1'");
  });

  it("gère les échappements supportés", () => {
    const { data } = parseToml(String.raw`command = "dit \"salut\"\net\ttabule"`);
    assert.equal(data["command"], 'dit "salut"\net\ttabule');
  });

  it("situe chaque clé et chaque table sur sa ligne", () => {
    const { lines } = parseToml(`
name = "budget"

[targets.dev]
port = 5178
`);
    assert.equal(lines.get("name"), 2);
    assert.equal(lines.get("targets.dev"), 4);
    assert.equal(lines.get("targets.dev.port"), 5);
  });
});

describe("constructions refusées", () => {
  it("refuse les tableaux", () => {
    refuses(`isolate = ["node_modules"]`, "tableaux ne sont pas supportés", 1);
  });

  it("refuse les tables en ligne", () => {
    refuses(`dev = { port = 5178 }`, "tables en ligne", 1);
  });

  it("refuse les tableaux de tables", () => {
    refuses(`[[targets]]`, "tableaux de tables", 1);
  });

  it("refuse les flottants", () => {
    refuses(`ratio = 1.5`, "flottants", 1);
  });

  it("refuse les chaînes littérales", () => {
    refuses(`command = 'npm run dev'`, "chaînes littérales", 1);
  });

  it("refuse un mot nu, et rappelle les guillemets", () => {
    refuses(`mode = workspace`, "entre guillemets", 1);
  });

  it("refuse une chaîne non terminée", () => {
    refuses(`name = "budget`, "chaîne non terminée", 1);
  });

  it("refuse un échappement inconnu", () => {
    refuses(String.raw`name = "a\qb"`, "échappement", 1);
  });

  it("refuse une valeur manquante", () => {
    refuses(`name =`, "valeur manquante", 1);
  });

  it("refuse une ligne qui n'est ni table ni affectation", () => {
    refuses(`\nname\n`, "ni une table ni une affectation", 2);
  });

  it("refuse les clés pointées", () => {
    refuses(`targets.dev = 1`, "clés pointées", 1);
  });

  it("refuse les clés entre guillemets", () => {
    refuses(`"name" = "budget"`, "entre guillemets", 1);
  });

  it("refuse une clé définie deux fois", () => {
    refuses(`name = "a"\nname = "b"`, "définie deux fois", 2);
  });

  it("refuse une table déclarée deux fois", () => {
    refuses(`[targets.dev]\nport = 1\n\n[targets.dev]\nport = 2`, "déclarée deux fois", 4);
  });

  it("refuse de descendre dans une valeur", () => {
    refuses(`targets = "x"\n\n[targets.dev]\nport = 1`, "est une valeur, pas une table", 3);
  });

  it("refuse un en-tête de table non fermé", () => {
    refuses(`[targets.dev`, "non fermé", 1);
  });

  it("refuse ce qui traîne après un en-tête de table", () => {
    refuses(`[targets.dev] port = 1`, "de trop après l'en-tête", 1);
  });
});
