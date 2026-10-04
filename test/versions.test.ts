import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avecCache, shaOf, versionInfo, webUrlOf } from "../src/versions.ts";

describe("version déployée : lien et retard local", () => {
  it("lit le SHA d'un tag, propre ou sale, jamais d'un tag horodaté", () => {
    assert.equal(shaOf("1e4e15071cb0"), "1e4e15071cb0");
    assert.equal(shaOf("1af1c7bcb4e6-sale"), "1af1c7bcb4e6");
    assert.equal(shaOf("t20260809203611"), null);
    assert.equal(shaOf("dev"), null);
  });

  it("déduit l'adresse web des trois formes de remote", () => {
    assert.equal(webUrlOf("git@github.com:Cdn21/budgetApp.git"), "https://github.com/Cdn21/budgetApp");
    assert.equal(webUrlOf("ssh://git@git.exemple.ts.net/quentin/DBox.git"), "https://git.exemple.ts.net/quentin/DBox");
    assert.equal(webUrlOf("ssh://git@forge:2222/a/b"), "https://forge/a/b");
    assert.equal(webUrlOf("https://forge.exemple/a/b.git\n"), "https://forge.exemple/a/b");
  });

  it("ne recopie jamais un identifiant d'une URL https dans la page", () => {
    const url = webUrlOf("https://moi:jeton-secret@forge.exemple/a/b.git");
    assert.equal(url, "https://forge.exemple/a/b");
    assert.doesNotMatch(url ?? "", /jeton/);
  });

  it("préfère aucun lien à un lien deviné", () => {
    assert.equal(webUrlOf("/srv/depots/app.git"), null);
    assert.equal(webUrlOf("file:///srv/app"), null);
    assert.equal(webUrlOf(""), null);
  });

  it("compte les commits de la source absents de la version déployée", async () => {
    const appels: string[][] = [];
    const git = async (args: string[]) => {
      appels.push(args);
      if (args.includes("config")) return { code: 0, stdout: "git@github.com:moi/app.git\n", stderr: "" };
      return { code: 0, stdout: "3\n", stderr: "" };
    };
    const info = await versionInfo("/src/app", "abc1234-sale", git);
    assert.deepEqual(info, { commitUrl: "https://github.com/moi/app/commit/abc1234", nonDeployes: 3 });
    assert.ok(appels.some((a) => a.includes("abc1234..HEAD")));
    // Jamais de fetch : la liste se rafraîchit toutes les 15 s.
    assert.ok(appels.every((a) => !a.includes("fetch")));
  });

  it("se tait quand la source n'est pas un dépôt", async () => {
    const git = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });
    assert.deepEqual(await versionInfo("/src/app", "abc1234", git), { commitUrl: null, nonDeployes: null });
  });

  it("garde le résultat une minute, puis recalcule", async () => {
    let calculs = 0;
    let t = 0;
    const cache = avecCache(async () => ({ commitUrl: null, nonDeployes: ++calculs }), () => t);
    await cache("/a", "abc1234");
    await cache("/a", "abc1234");
    assert.equal(calculs, 1);
    t = 61_000;
    await cache("/a", "abc1234");
    assert.equal(calculs, 2);
  });
});
