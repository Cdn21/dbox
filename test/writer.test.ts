import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeFiles } from "../src/writer.ts";

const created: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dbox-test-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  // Les dossiers temporaires sont laissés à l'OS ; on ne supprime rien de nous-mêmes.
  created.length = 0;
});

describe("écriture d'un plan", () => {
  it("crée les dossiers manquants", async () => {
    const root = await scratch();
    const path = join(root, "budget", "prod", "docker-compose.yml");

    const outcomes = await writeFiles([{ path, content: "name: dbox\n" }]);

    assert.deepEqual(outcomes, [{ path, written: true }]);
    assert.equal(await readFile(path, "utf8"), "name: dbox\n");
  });

  it("applique les permissions demandées aux secrets", async () => {
    const root = await scratch();
    const path = join(root, "ts.env");

    await writeFiles([{ path, content: "TS_AUTHKEY=\n", mode: 0o600 }]);

    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
  });

  it("n'écrase jamais un fichier préservé qui existe déjà", async () => {
    const root = await scratch();
    const path = join(root, "ts.env");
    await writeFile(path, "TS_AUTHKEY=tskey-secret-déjà-renseignée\n");

    const outcomes = await writeFiles([
      { path, content: "TS_AUTHKEY=\n", mode: 0o600, preserveIfExists: true },
    ]);

    assert.deepEqual(outcomes, [{ path, written: false }]);
    // C'est tout l'enjeu : un déploiement ne doit pas effacer la clé d'auth.
    assert.match(await readFile(path, "utf8"), /tskey-secret/);
  });

  it("crée bien un fichier préservé lorsqu'il n'existe pas encore", async () => {
    const root = await scratch();
    const path = join(root, ".env");

    const outcomes = await writeFiles([{ path, content: "# vide\n", preserveIfExists: true }]);

    assert.deepEqual(outcomes, [{ path, written: true }]);
    assert.equal(await readFile(path, "utf8"), "# vide\n");
  });

  it("réécrit le compose à chaque fois, lui", async () => {
    const root = await scratch();
    const path = join(root, "docker-compose.yml");
    await writeFile(path, "ancien\n");

    await writeFiles([{ path, content: "nouveau\n" }]);

    assert.equal(await readFile(path, "utf8"), "nouveau\n");
  });
});
