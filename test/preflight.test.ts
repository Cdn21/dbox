import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT, type Context } from "../src/compose.ts";
import { parseManifest, type Target } from "../src/manifest.ts";
import { planFor } from "../src/plan.ts";
import { CHEMINS_SONDES, preflight, SOUS_DOSSIERS_FRONT } from "../src/preflight.ts";

const CTX: Context = {
  ...DEFAULT_CONTEXT,
  tailnet: "mon-tailnet.ts.net",
  uid: 1000,
  gid: 1000,
  sourcePath: "/home/cde/dev/monapp",
};

/** Le couple plan + cible tel que `up()` le passe au contrôle. */
function cas(toml: string, cible: string): { plan: ReturnType<typeof planFor>; target: Target } {
  const manifest = parseManifest(toml);
  return { plan: planFor(manifest, cible, CTX), target: manifest.targets[cible]! };
}

const DEVCONTAINER = `
name = "monapp"
[targets.dev]
mode = "devcontainer"
port = 5173
command = "npm run dev"
`;

const WORKSPACE = `
name = "monapp"
[targets.dev]
mode = "workspace"
port = 5173
command = "npm run dev"
`;

const DEPLOYED = `
name = "monapp"
[targets.prod]
mode = "deployed"
port = 8080
`;

/** Une config Vite plausible, sans aucun des réglages qu'on cherche. */
const VITE_NU = `import { defineConfig } from 'vite'
export default defineConfig({ server: { port: 5173 } })`;

const codes = (avis: { code: string }[]): string[] => avis.map((a) => a.code);

describe("contrôle d'avant-construction : Vite", () => {
  it("signale l'absence d'allowedHosts, et donne le nom exact à autoriser", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const avis = preflight(plan, target, new Map([["vite.config.ts", VITE_NU]]));
    const trouve = avis.find((a) => a.code === "vite-allowed-hosts");
    assert.ok(trouve, "le contrôle doit se déclencher");
    // Le nom vient du plan, jamais reconstruit à la main : c'est celui que le
    // sidecar annoncera, donc celui qui arrivera en en-tête Host.
    assert.match(trouve.message, /monapp-dev\.mon-tailnet\.ts\.net/);
    assert.match(trouve.message, /403/);
  });

  it("se tait dès que « allowedHosts » apparaît, sous quelque forme que ce soit", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    // `true`, une liste construite dynamiquement, une variable : DBox ne cherche
    // pas à comprendre. Au moindre doute il se tait — un faux avertissement
    // apprend à ignorer les vrais.
    for (const contenu of [
      "server: { allowedHosts: true }",
      "server: { allowedHosts: process.env.HOSTS.split(',') }",
      "// allowedHosts géré ailleurs",
    ]) {
      const avis = preflight(plan, target, new Map([["vite.config.ts", contenu]]));
      assert.ok(!codes(avis).includes("vite-allowed-hosts"), `aurait dû se taire sur : ${contenu}`);
    }
  });

  it("trouve la config dans un sous-dossier de front, pas seulement à la racine", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const avis = preflight(plan, target, new Map([["frontend/vite.config.ts", VITE_NU]]));
    const trouve = avis.find((a) => a.code === "vite-allowed-hosts");
    assert.ok(trouve);
    assert.match(trouve.message, /^frontend\/vite\.config\.ts/);
  });

  it("ne dit rien sur une cible deployed : elle sert une app construite", () => {
    const { plan, target } = cas(DEPLOYED, "prod");
    const avis = preflight(plan, target, new Map([["vite.config.ts", VITE_NU]]));
    assert.deepEqual(avis, []);
  });

  it("ne dit rien sans config Vite : on ne devine pas le serveur de développement", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    assert.deepEqual(preflight(plan, target, new Map()), []);
  });
});

describe("contrôle d'avant-construction : écoute locale", () => {
  it("signale une config sans « host » quand la commande n'a pas « --host »", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const avis = preflight(plan, target, new Map([["vite.config.ts", VITE_NU]]));
    assert.ok(codes(avis).includes("ecoute-locale"));
  });

  it("se tait si la config pose « host »", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const avec = "server: { host: true, allowedHosts: ['x'] }";
    assert.deepEqual(preflight(plan, target, new Map([["vite.config.ts", avec]])), []);
  });

  it("se tait si la commande porte « --host »", () => {
    const manifest = parseManifest(`
name = "monapp"
[targets.dev]
mode = "devcontainer"
port = 5173
command = "npm run dev -- --host"
`);
    const avis = preflight(
      planFor(manifest, "dev", CTX),
      manifest.targets["dev"]!,
      new Map([["vite.config.ts", "server: { allowedHosts: ['x'] }"]]),
    );
    assert.deepEqual(avis, []);
  });

  it("ne prend pas « allowedHosts » pour un réglage d'écoute", () => {
    // Le piège : « allowedHosts: » contient « Hosts: ». Une recherche naïve de
    // « host: » y verrait une écoute configurée et se tairait à tort.
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const avis = preflight(plan, target, new Map([["vite.config.ts", "server: { allowedHosts: ['x'] }"]]));
    assert.ok(codes(avis).includes("ecoute-locale"));
  });

  it("adapte le message au mode : l'hôte en workspace, le conteneur sinon", () => {
    const dev = cas(DEVCONTAINER, "dev");
    const ws = cas(WORKSPACE, "dev");
    const m = (c: ReturnType<typeof cas>) =>
      preflight(c.plan, c.target, new Map([["vite.config.ts", VITE_NU]])).find((a) => a.code === "ecoute-locale")!
        .message;
    assert.match(m(ws), /host\.docker\.internal/);
    assert.match(m(dev), /réseau interne/);
  });
});

describe("contrôle d'avant-construction : devcontainer JVM", () => {
  const JVM = new Map([
    ["gradlew", "#!/bin/sh"],
    ["vite.config.ts", "server: { host: true, allowedHosts: ['x'] }"],
  ]);

  it("signale l'image par défaut, qui n'a pas de JDK", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const trouve = preflight(plan, target, JVM).find((a) => a.code === "devcontainer-sans-jdk");
    assert.ok(trouve);
    assert.match(trouve.message, /gradlew/);
  });

  it("se tait dès qu'un dockerfile est posé", () => {
    const { plan, target } = cas(`${DEVCONTAINER}dockerfile = "Dockerfile.dev"\ndata = "/home/ubuntu/.gradle"\n`, "dev");
    assert.deepEqual(preflight(plan, target, JVM), []);
  });

  it("signale le cache volatil, et nomme le bon chemin selon l'outil", () => {
    const { plan, target } = cas(`${DEVCONTAINER}dockerfile = "Dockerfile.dev"\n`, "dev");
    const gradle = preflight(plan, target, JVM).find((a) => a.code === "cache-jvm-volatil");
    assert.ok(gradle);
    assert.match(gradle.message, /\$HOME\/\.gradle/);

    const maven = new Map([["pom.xml", "<project/>"]]);
    const trouve = preflight(plan, target, maven).find((a) => a.code === "cache-jvm-volatil");
    assert.match(trouve!.message, /\$HOME\/\.m2/);
  });

  it("ne dit rien sur un projet sans marqueur JVM", () => {
    const { plan, target } = cas(DEVCONTAINER, "dev");
    const avis = preflight(plan, target, new Map([["vite.config.ts", "server: { host: true, allowedHosts: [] }"]]));
    assert.deepEqual(avis, []);
  });

  it("ne s'applique pas au mode workspace : DBox n'y construit aucune image", () => {
    const { plan, target } = cas(WORKSPACE, "dev");
    const avis = preflight(plan, target, JVM);
    assert.deepEqual(codes(avis), []);
  });
});

describe("les chemins sondés", () => {
  it("couvrent la racine et chaque sous-dossier de front, pour les quatre extensions", () => {
    assert.ok(CHEMINS_SONDES.includes("vite.config.ts"));
    for (const sous of SOUS_DOSSIERS_FRONT) {
      assert.ok(CHEMINS_SONDES.includes(`${sous}/vite.config.ts`), `manque ${sous}`);
      assert.ok(CHEMINS_SONDES.includes(`${sous}/vite.config.mjs`));
    }
    for (const marqueur of ["gradlew", "build.gradle.kts", "pom.xml"]) {
      assert.ok(CHEMINS_SONDES.includes(marqueur));
    }
  });

  it("reste borné : le contrôle ne doit pas coûter une exploration du dépôt", () => {
    assert.ok(CHEMINS_SONDES.length <= 40, `${CHEMINS_SONDES.length} chemins, c'est trop pour chaque déploiement`);
  });
});
