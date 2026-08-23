import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daysUntil, expiryPath, readAuthkeyNotice } from "../src/authkey.ts";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("chemin du fichier d'expiration", () => {
  it("est toujours à côté de la clé", () => {
    assert.equal(expiryPath("/home/serve/dbox/authkey"), "/home/serve/dbox/authkey.expires");
  });
});

describe("calcul des jours restants", () => {
  it("compte en jours calendaires, pas en heures", () => {
    // Même si « maintenant » est à midi, l'échéance de minuit compte pour 1 jour.
    assert.equal(daysUntil("2026-08-14", NOW), 1);
    assert.equal(daysUntil("2026-08-13", NOW), 0);
  });

  it("rend un nombre négatif pour une date passée", () => {
    assert.equal(daysUntil("2026-08-10", NOW), -3);
  });
});

describe("lecture de l'avertissement", () => {
  const lit = (contenu: string | null) => (path: string) =>
    contenu === null ? Promise.reject(new Error(`absent : ${path}`)) : Promise.resolve(contenu);

  it("rend l'échéance et les jours restants", async () => {
    const notice = await readAuthkeyNotice("/home/serve/dbox/authkey", lit("2026-11-07\n"), NOW);
    assert.deepEqual(notice, { expiresOn: "2026-11-07", daysLeft: 86 });
  });

  it("ne casse rien quand le fichier est absent", async () => {
    assert.equal(await readAuthkeyNotice("/home/serve/dbox/authkey", lit(null), NOW), null);
  });

  it("ne casse rien sur une date mal formée", async () => {
    assert.equal(await readAuthkeyNotice("/home/serve/dbox/authkey", lit("bientôt"), NOW), null);
  });

  it("rend null sans fichier de clé configuré", async () => {
    assert.equal(await readAuthkeyNotice(undefined, lit("2026-11-07"), NOW), null);
  });
});
