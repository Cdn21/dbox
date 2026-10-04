import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const lire = (module: string) => readFile(new URL(`../src/ui/${module}.ts`, import.meta.url), "utf8");

describe("gabarits embarqués", () => {
  it("aucun accent grave n'interrompt la feuille de style ni le script", async () => {
    // Ils vivent dans des template literals : un accent grave les termine en
    // plein milieu. Le symptôme est trompeur — tsc et le lanceur de tests
    // pointent une erreur de syntaxe *ailleurs*, dans un fichier qui importe
    // celui-ci. Piège tombé deux fois en citant un nom de propriété CSS entre
    // accents graves, dans un commentaire.
    //
    // Le fichier est lu comme du **texte**, pas importé : un module cassé ne
    // se charge pas, et l'assertion ne tournerait jamais. La convention du
    // fichier fixe la borne : un gabarit se ferme sur une ligne « `; » seule.
    const lignes = (await lire("chrome")).split("\n");

    for (const nom of ["STYLE", "SCRIPT"]) {
      const ouverture = lignes.findIndex((l) => l.startsWith(`const ${nom} = ` + "`"));
      assert.ok(ouverture >= 0, `${nom} introuvable dans ui/chrome.ts`);

      const fermeture = lignes.findIndex((l, i) => i > ouverture && l === "`;");
      assert.ok(fermeture > 0, `${nom} n'est jamais fermé par une ligne « \`; »`);

      const fautives = lignes
        .slice(ouverture + 1, fermeture)
        .map((ligne, i) => [ouverture + 2 + i, ligne] as const)
        .filter(([, ligne]) => ligne.includes("`"));

      assert.deepEqual(
        fautives,
        [],
        `accent grave dans ${nom} : il termine le gabarit, et l'erreur remontera ailleurs`,
      );
    }
  });

  it("chaque module de rendu échappe ce qui vient du disque", async () => {
    // Invariant 8, vérifié grossièrement : la présence de l'import attrape
    // l'oubli le plus probable — un nouveau module qui n'y pense pas.
    for (const module of ["cartes", "panneaux", "reglages", "ajout"]) {
      assert.match(await lire(module), /escape/, `ui/${module}.ts n'échappe rien`);
    }
  });
});
