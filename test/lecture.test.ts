import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { lireSiFichierOrdinaire, TAILLE_MAX } from "../src/lecture.ts";

describe("lire un fichier du projet sans risquer de bloquer", () => {
  it("lit un fichier ordinaire", async () => {
    const d = await mkdtemp(`${tmpdir()}/dbox-lecture-`);
    await writeFile(`${d}/vite.config.ts`, "export default {}");
    assert.equal(await lireSiFichierOrdinaire(`${d}/vite.config.ts`), "export default {}");
  });

  it("suit un lien symbolique vers un fichier ordinaire", async () => {
    const d = await mkdtemp(`${tmpdir()}/dbox-lecture-`);
    await writeFile(`${d}/vrai.ts`, "x");
    await symlink(`${d}/vrai.ts`, `${d}/vite.config.ts`);
    assert.equal(await lireSiFichierOrdinaire(`${d}/vite.config.ts`), "x");
  });

  it("ne bloque pas sur un tube nommé : il vaut « absent »", async () => {
    // Avec un readFile nu, cette lecture ne rendait jamais la main — vérifié à la revue.
    const d = await mkdtemp(`${tmpdir()}/dbox-lecture-`);
    execFileSync("mkfifo", [`${d}/vite.config.ts`]);
    const debut = Date.now();
    assert.equal(await lireSiFichierOrdinaire(`${d}/vite.config.ts`), null);
    assert.ok(Date.now() - debut < 1000);
  });

  it("lit un fichier qui annonce 0 octet : la lecture, pas le stat, fait foi", async () => {
    // Un fichier de /proc annonce 0 octet : seule la lecture dit la vérité.
    const contenu = await lireSiFichierOrdinaire("/proc/self/status");
    assert.ok(contenu !== null && contenu.length > 0);
  });

  it("ignore un dossier, un fichier absent, un fichier trop gros", async () => {
    const d = await mkdtemp(`${tmpdir()}/dbox-lecture-`);
    assert.equal(await lireSiFichierOrdinaire(d), null);
    assert.equal(await lireSiFichierOrdinaire(`${d}/absent`), null);
    await writeFile(`${d}/gros`, Buffer.alloc(TAILLE_MAX + 1));
    assert.equal(await lireSiFichierOrdinaire(`${d}/gros`), null);
    // Pile à la limite, il passe encore.
    await writeFile(`${d}/limite`, Buffer.alloc(TAILLE_MAX, 0x61));
    assert.equal((await lireSiFichierOrdinaire(`${d}/limite`))?.length, TAILLE_MAX);
  });
});
