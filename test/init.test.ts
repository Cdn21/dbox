import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseConfig, serializeConfig } from "../src/config.ts";
import { draft, nameFromDirectory, readDockerfile, renderManifest, renderScaffold, targetNameFor } from "../src/init.ts";
import { parseManifest } from "../src/manifest.ts";
import { nameFromUrl } from "../src/sources.ts";
import { seedAuthKey } from "../src/writer.ts";
import { readFile } from "node:fs/promises";

describe("nom déduit du dossier", () => {
  it("rabote au format d'un nom de machine", () => {
    assert.equal(nameFromDirectory("/home/serve/dbox/budget"), "budget");
    // C'est exactement le cas qui faisait échouer le manifeste à la main.
    assert.equal(nameFromDirectory("/w/repartition_budget"), "repartition-budget");
    assert.equal(nameFromDirectory("/w/Mon Projet.v2"), "mon-projet-v2");
    assert.equal(nameFromDirectory("/w/budget/"), "budget");
  });

  it("ne rend jamais un nom vide", () => {
    assert.equal(nameFromDirectory("/w/___"), "app");
  });
});

describe("lecture du Dockerfile", () => {
  it("prend le premier EXPOSE et le premier VOLUME", () => {
    const read = readDockerfile(`FROM python:3.12-slim
EXPOSE 5000
VOLUME /data
EXPOSE 9999
`);
    assert.deepEqual(read, { port: 5000, data: "/data" });
  });

  it("comprend la forme en tableau de VOLUME", () => {
    assert.equal(readDockerfile('VOLUME ["/var/lib/app", "/tmp"]').data, "/var/lib/app");
  });

  it("ignore un port hors bornes", () => {
    assert.equal(readDockerfile("EXPOSE 99999").port, null);
  });

  it("rend null quand le Dockerfile ne dit rien", () => {
    assert.deepEqual(readDockerfile("FROM scratch"), { port: null, data: null });
  });
});

describe("manifeste produit", () => {
  it("est accepté par le parseur, et signale le port deviné", () => {
    const proposal = draft("/home/serve/dbox/budget", null);
    const source = renderManifest(proposal, true);

    assert.match(source, /deviné/);
    const manifest = parseManifest(source);
    assert.equal(manifest.name, "budget");
    assert.deepEqual(manifest.targets["prod"], {
      mode: "deployed",
      port: 8080,
      dockerfile: "Dockerfile",
      health: "/",
      data: null,
      autoDeploy: false,
      tsTag: null,
      sshPort: null,
    });
  });

  it("reprend le port et le volume du Dockerfile", () => {
    const proposal = draft("/w/budget", "FROM x\nEXPOSE 5000\nVOLUME /data\n");
    const manifest = parseManifest(renderManifest(proposal, false));
    const target = manifest.targets["prod"]!;
    assert.equal(target.port, 5000);
    assert.equal(target.mode === "deployed" ? target.data : null, "/data");
  });
});

describe("squelette pour le formulaire d'ajout", () => {
  it("nomme la cible selon le mode : prod pour déployé, dev sinon", () => {
    assert.equal(targetNameFor("deployed"), "prod");
    assert.equal(targetNameFor("workspace"), "dev");
    assert.equal(targetNameFor("devcontainer"), "dev");
  });

  it("produit un manifeste valide en workspace, avec la commande fournie", () => {
    const toml = renderScaffold({ name: "budget", mode: "workspace", port: 5178, command: "npm run dev" });
    const manifest = parseManifest(toml);
    assert.deepEqual(manifest.targets["dev"], {
      mode: "workspace",
      command: "npm run dev",
      port: 5178,
      health: "/",
      tsTag: null,
      sshPort: null,
    });
  });

  it("produit un manifeste valide en deployed, sans commande", () => {
    const toml = renderScaffold({ name: "budget", mode: "deployed", port: 8080 });
    const manifest = parseManifest(toml);
    assert.deepEqual(manifest.targets["prod"], {
      mode: "deployed",
      port: 8080,
      dockerfile: "Dockerfile",
      health: "/",
      data: null,
      autoDeploy: false,
      tsTag: null,
      sshPort: null,
    });
  });

  it("échappe une commande contenant des guillemets", () => {
    const toml = renderScaffold({ name: "a", mode: "workspace", port: 80, command: 'echo "salut"' });
    const manifest = parseManifest(toml);
    assert.equal(manifest.targets["dev"]!.mode === "workspace" ? manifest.targets["dev"]!.command : null, 'echo "salut"');
  });
});

describe("nom déduit de l'URL d'un dépôt", () => {
  it("comprend les trois formes d'URL", () => {
    assert.equal(nameFromUrl("git@github.com:Cdn21/budgetApp.git"), "budgetapp");
    assert.equal(nameFromUrl("https://github.com/Cdn21/budgetApp"), "budgetapp");
    assert.equal(nameFromUrl("/srv/depots/mon_projet.git"), "mon-projet");
  });

  it("rabote comme un nom de dossier : c'est un nom de machine", () => {
    assert.equal(nameFromUrl("git@github.com:x/Repartition_Budget.git"), "repartition-budget");
    assert.equal(nameFromUrl("https://exemple.fr/x/depot/"), "depot");
  });
});

describe("configuration de la machine", () => {
  it("lit les réglages de la machine, dont sa cible par défaut", () => {
    assert.deepEqual(
      parseConfig(`
root = "/home/serve/dbox/apps"
tailnet = "tail4bb652.ts.net"
ts_tag = "tag:dbox"
authkey_file = "/home/serve/dbox/authkey"
target = "prod"
`),
      {
        root: "/home/serve/dbox/apps",
        tailnet: "tail4bb652.ts.net",
        tsTag: "tag:dbox",
        authkeyFile: "/home/serve/dbox/authkey",
        target: "prod",
      },
    );
  });

  it("refuse une clé inconnue plutôt que de l'ignorer", () => {
    assert.throws(() => parseConfig('tailnett = "x"'), /clé inconnue/);
  });
});

describe("sérialisation de la configuration", () => {
  it("fait l'aller-retour avec parseConfig", () => {
    const config = {
      root: "/home/cde/dbox/apps",
      tailnet: "tail4bb652.ts.net",
      tsTag: "tag:dbox",
      target: "dev",
      authkeyFile: "/home/cde/dbox/authkey",
    };
    assert.deepEqual(parseConfig(serializeConfig(config)), config);
  });

  it("omet les champs absents plutôt que d'écrire une chaîne vide", () => {
    const toml = serializeConfig({ tailnet: "tail4bb652.ts.net" });
    assert.equal(toml, 'tailnet = "tail4bb652.ts.net"\n');
    assert.deepEqual(parseConfig(toml), { tailnet: "tail4bb652.ts.net" });
  });
});

describe("semis de la clé d'auth", () => {
  async function scratch(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "dbox-key-"));
  }

  it("remplit un ts.env qui vient d'être créé", async () => {
    const root = await scratch();
    const keyFile = join(root, "authkey");
    const tsEnv = join(root, "ts.env");
    await writeFile(keyFile, "tskey-auth-abc\n");
    await writeFile(tsEnv, "TS_AUTHKEY=\n");

    const seeded = await seedAuthKey([{ path: tsEnv, written: true }], keyFile);

    assert.equal(seeded, tsEnv);
    assert.equal(await readFile(tsEnv, "utf8"), "TS_AUTHKEY=tskey-auth-abc\n");
  });

  it("ne touche pas un ts.env préservé", async () => {
    const root = await scratch();
    const keyFile = join(root, "authkey");
    const tsEnv = join(root, "ts.env");
    await writeFile(keyFile, "tskey-auth-neuve\n");
    await writeFile(tsEnv, "TS_AUTHKEY=tskey-auth-deja-en-place\n");

    // `written: false` = le fichier existait : c'est la règle qui protège les
    // clés déjà posées, elle prime sur le semis.
    const seeded = await seedAuthKey([{ path: tsEnv, written: false }], keyFile);

    assert.equal(seeded, null);
    assert.match(await readFile(tsEnv, "utf8"), /deja-en-place/);
  });

  it("ne fait rien sans fichier de clé configuré", async () => {
    assert.equal(await seedAuthKey([{ path: "/x/ts.env", written: true }], undefined), null);
  });

  it("ne fait rien si le fichier de clé est absent ou vide", async () => {
    const root = await scratch();
    const tsEnv = join(root, "ts.env");
    await writeFile(tsEnv, "TS_AUTHKEY=\n");
    assert.equal(await seedAuthKey([{ path: tsEnv, written: true }], join(root, "absent")), null);

    const vide = join(root, "vide");
    await writeFile(vide, "  \n");
    assert.equal(await seedAuthKey([{ path: tsEnv, written: true }], vide), null);
  });
});
