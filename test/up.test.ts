import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT, type Context } from "../src/compose.ts";
import type { RunResult } from "../src/docker.ts";
import { parseManifest } from "../src/manifest.ts";
import type { Descriptor, PlannedFile } from "../src/plan.ts";
import { up, type State, type UpDeps } from "../src/up.ts";

const CTX: Context = {
  ...DEFAULT_CONTEXT,
  tailnet: "mon-tailnet.ts.net",
  uid: 1000,
  gid: 1000,
  sourcePath: "/home/serve/budget",
};

const DEPLOYED = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
health = "/healthz"
`);

const WORKSPACE = parseManifest(`
name = "budget"
[targets.dev]
mode = "workspace"
command = "npm run dev"
port = 5178
`);

interface Harness {
  deps: UpDeps;
  calls: string[][];
  written: string[][];
  state: State | null;
  logs: string[];
}

function harness(options: {
  codes?: Record<string, number>;
  statuses?: (number | null)[];
  state?: State | null;
  /** Les cibles déjà déployées, pour le contrôle d'unicité du domaine public. */
  deployed?: Descriptor[];
  /** Les fichiers du projet que le contrôle d'avant-construction trouvera,
   * par chemin relatif au dossier source. */
  source?: Record<string, string>;
}): Harness {
  const calls: string[][] = [];
  const written: string[][] = [];
  const logs: string[] = [];
  const statuses = options.statuses ?? [200];
  let probeIndex = 0;
  let time = 0;

  const harnessed: Harness = {
    calls,
    written,
    logs,
    state: options.state ?? null,
    deps: {
      compose: async (_directory, args): Promise<RunResult> => {
        calls.push(args);
        const code = options.codes?.[args[0]!] ?? 0;
        return { code, stdout: "", stderr: code === 0 ? "" : `échec de ${args[0]}` };
      },
      probe: async () => statuses[Math.min(probeIndex++, statuses.length - 1)] ?? null,
      writeFiles: async (files: PlannedFile[]) => {
        written.push(files.map((file) => file.path));
        return files.map((file) => ({ path: file.path, written: true }));
      },
      seedAuthKey: async () => null,
      readSource: async (chemin) => {
        const relatif = chemin.replace(`${CTX.sourcePath}/`, "");
        return options.source?.[relatif] ?? null;
      },
      readState: async () => harnessed.state,
      writeState: async (_directory, next) => {
        harnessed.state = next;
      },
      // Aucune autre cible déployée par défaut : le contrôle d'unicité du
      // domaine ne se déclenche que dans les tests qui la remplacent.
      listDescriptors: async () => options.deployed ?? [],
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
      log: (line) => logs.push(line),
    },
  };

  return harnessed;
}

const verbs = (calls: string[][]) => calls.map((args) => args[0]);

describe("déploiement réussi", () => {
  it("construit, démarre, vérifie, puis enregistre la version", async () => {
    const test = harness({});
    const result = await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "abc123" }, test.deps);

    assert.equal(result.ok, true);
    assert.deepEqual(verbs(test.calls), ["build", "up"]);
    assert.equal(result.plan.healthUrl, "https://budget.mon-tailnet.ts.net/healthz");
    assert.deepEqual(test.state, {
      tag: "abc123",
      previousTag: null,
      deployedAt: new Date(0).toISOString(),
    });
  });

  it("chaîne la version précédente", async () => {
    const test = harness({ state: { tag: "vieux", previousTag: null, deployedAt: "" } });
    await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "neuf" }, test.deps);

    assert.equal(test.state?.tag, "neuf");
    assert.equal(test.state?.previousTag, "vieux");
  });

  it("ne construit rien en mode workspace", async () => {
    const test = harness({});
    const result = await up({ manifest: WORKSPACE, target: "dev", ctx: CTX, tag: "abc" }, test.deps);

    assert.equal(result.ok, true);
    assert.deepEqual(verbs(test.calls), ["up"]);
  });
});

describe("compagnons et variables d'environnement", () => {
  const AVEC_DB = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
[targets.prod.services.db]
image = "postgres:16-alpine"
`);

  it("prévient quand le .env vient d'être créé vide et qu'un compagnon en dépend", async () => {
    // Sinon postgres redémarre en boucle pendant que l'app répond 200 : le
    // contrôle de santé porte sur l'app, il ne voit jamais le compagnon.
    const test = harness({});
    const result = await up({ manifest: AVEC_DB, target: "prod", ctx: CTX, tag: "abc" }, test.deps);

    assert.equal(result.ok, true);
    assert.ok(test.logs.some((l) => l.includes("db") && l.includes(".env")));
  });

  it("ne dit rien quand le .env existait déjà — l'utilisateur l'a rempli", async () => {
    const test = harness({});
    test.deps.writeFiles = async (files) => {
      test.written.push(files.map((f) => f.path));
      return files.map((f) => ({ path: f.path, written: !f.path.endsWith("/.env") }));
    };

    await up({ manifest: AVEC_DB, target: "prod", ctx: CTX, tag: "abc" }, test.deps);
    assert.equal(test.logs.some((l) => l.includes("vient d'être créé vide")), false);
  });

  it("ne dit rien pour une cible sans compagnon", async () => {
    const test = harness({});
    await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "abc" }, test.deps);
    assert.equal(test.logs.some((l) => l.includes("vient d'être créé vide")), false);
  });

  it("dit qu'un retour arrière ne ramène pas les données du compagnon", async () => {
    // L'invariant 4 devient partiel dès qu'il y a de l'état : revenir à l'image
    // précédente ne défait pas une migration déjà appliquée à la base.
    const test = harness({ statuses: [null], state: { tag: "vieux", previousTag: null, deployedAt: "" } });
    const avecData = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
[targets.prod.services.db]
image = "postgres:16-alpine"
data = "/var/lib/postgresql/data"
`);

    await up(
      { manifest: avecData, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );
    assert.ok(test.logs.some((l) => l.includes("jamais les données")));
  });

  it("ne le dit pas quand aucun compagnon ne stocke", async () => {
    const test = harness({ statuses: [null], state: { tag: "vieux", previousTag: null, deployedAt: "" } });
    await up(
      { manifest: AVEC_DB, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );
    assert.equal(test.logs.some((l) => l.includes("jamais les données")), false);
  });
});

describe("unicité du domaine public", () => {
  const CTX_TRAEFIK: Context = {
    ...CTX,
    traefik: { network: "traefik-net", certResolver: "letsencrypt" },
  };

  const PUBLIC = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
public_domain = "budget.exemple.fr"
`);

  function deja(over: Partial<Descriptor>): Descriptor {
    return {
      app: "autre",
      target: "prod",
      mode: "deployed",
      hostname: "autre",
      url: "https://autre.mon-tailnet.ts.net",
      healthUrl: "https://autre.mon-tailnet.ts.net/",
      project: "dbox-autre-prod",
      source: "/home/serve/autre",
      autoDeploy: false,
      services: [],
      publicDomain: "budget.exemple.fr",
      backend: "tailscale",
      ...over,
    };
  }

  it("refuse quand une autre cible revendique déjà ce domaine, sans rien écrire", async () => {
    const test = harness({ deployed: [deja({})] });
    const result = await up({ manifest: PUBLIC, target: "prod", ctx: CTX_TRAEFIK, tag: "abc" }, test.deps);

    assert.equal(result.ok, false);
    assert.equal(result.failure, "domaine");
    assert.match(result.detail ?? "", /autre · prod/);
    // Rien n'a été écrit ni démarré : le refus arrive avant toute action.
    assert.deepEqual(test.written, []);
    assert.deepEqual(test.calls, []);
  });

  it("laisse passer le redéploiement de la cible elle-même", async () => {
    const test = harness({ deployed: [deja({ app: "budget", target: "prod" })] });
    const result = await up({ manifest: PUBLIC, target: "prod", ctx: CTX_TRAEFIK, tag: "abc" }, test.deps);
    assert.equal(result.ok, true);
  });

  it("refuse deux cibles de la même app qui partagent un domaine", async () => {
    const test = harness({ deployed: [deja({ app: "budget", target: "dev" })] });
    const result = await up({ manifest: PUBLIC, target: "prod", ctx: CTX_TRAEFIK, tag: "abc" }, test.deps);
    assert.equal(result.failure, "domaine");
    assert.match(result.detail ?? "", /budget · dev/);
  });

  it("ignore les cibles privées, quel que soit leur nombre", async () => {
    const test = harness({ deployed: [deja({ publicDomain: null }), deja({ app: "x", publicDomain: null })] });
    const result = await up({ manifest: PUBLIC, target: "prod", ctx: CTX_TRAEFIK, tag: "abc" }, test.deps);
    assert.equal(result.ok, true);
  });

  it("ne consulte même pas le registre pour une cible privée", async () => {
    let consulte = false;
    const test = harness({});
    test.deps.listDescriptors = async () => {
      consulte = true;
      return [];
    };
    await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "abc" }, test.deps);
    assert.equal(consulte, false);
  });
});

describe("échec de construction", () => {
  it("ne démarre rien : la version en place continue de tourner", async () => {
    const test = harness({
      codes: { build: 1 },
      state: { tag: "vieux", previousTag: null, deployedAt: "" },
    });
    const result = await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "casse" }, test.deps);

    assert.equal(result.ok, false);
    assert.equal(result.failure, "construction");
    assert.deepEqual(verbs(test.calls), ["build"]);
    // Ni retour arrière — il n'y a rien à annuler — ni changement d'état.
    assert.equal(result.rolledBackTo, null);
    assert.equal(test.state?.tag, "vieux");
  });
});

describe("échec de santé", () => {
  it("revient à la version précédente", async () => {
    const test = harness({
      statuses: [null],
      state: { tag: "vieux", previousTag: null, deployedAt: "" },
    });
    const result = await up(
      { manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );

    assert.equal(result.ok, false);
    assert.equal(result.failure, "santé");
    assert.equal(result.rolledBackTo, "vieux");
    assert.deepEqual(verbs(test.calls), ["build", "up", "up"]);
    // Jamais de construction au retour : elle partirait des sources qui
    // viennent d'échouer, sous le tag de l'ancienne version.
    assert.deepEqual(test.calls.at(-1), ["up", "-d", "--no-build"]);
    // Le retour n'écrit que le compose, pas les fichiers de secrets.
    assert.deepEqual(test.written.at(-1), ["/opt/dbox/apps/budget/prod/docker-compose.yml"]);
    // L'état reste sur la version qui marche.
    assert.equal(test.state?.tag, "vieux");
  });

  it("laisse la pile en place au tout premier déploiement", async () => {
    const test = harness({ statuses: [null], state: null });
    const result = await up(
      { manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );

    assert.equal(result.failure, "santé");
    assert.equal(result.rolledBackTo, null);
    assert.deepEqual(verbs(test.calls), ["build", "up"]);
    assert.equal(test.state, null);
  });

  it("ne coupe pas un environnement de développement qui tournait", async () => {
    const test = harness({
      statuses: [null],
      state: { tag: "vieux", previousTag: null, deployedAt: "" },
    });
    const result = await up(
      { manifest: WORKSPACE, target: "dev", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );

    assert.equal(result.failure, "santé");
    assert.equal(result.rolledBackTo, null);
    assert.deepEqual(verbs(test.calls), ["up"]);
  });

  it("pointe vers tagOwners quand la cible a son propre ts_tag et ne répond jamais", async () => {
    const tagged = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
ts_tag = "tag:secret"
`);
    const test = harness({ statuses: [null], state: null });
    const result = await up(
      { manifest: tagged, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );

    assert.match(result.detail ?? "", /tag:secret/);
    assert.match(result.detail ?? "", /tagOwners/);
    assert.ok(test.logs.some((line) => line.includes("tag:secret") && line.includes("tagOwners")));
  });

  it("ne dit rien sur les tags quand la cible n'en a pas", async () => {
    const test = harness({ statuses: [null], state: null });
    const result = await up(
      { manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );

    assert.doesNotMatch(result.detail ?? "", /tagOwners/);
  });

  it("ne dit rien sur les tags quand la santé répond, même avec un mauvais statut", async () => {
    // Un statut reçu (fût-il 500) prouve que le sidecar s'est bien enregistré :
    // ce n'est pas le symptôme d'un tag manquant, pas la peine du même indice.
    const tagged = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
ts_tag = "tag:secret"
`);
    const test = harness({ statuses: [500], state: null });
    const result = await up(
      { manifest: tagged, target: "prod", ctx: CTX, tag: "neuf", healthTimeoutMs: 5, healthIntervalMs: 1 },
      test.deps,
    );

    assert.doesNotMatch(result.detail ?? "", /tagOwners/);
  });
});

describe("échec de démarrage", () => {
  it("tente le retour arrière sans vérifier la santé", async () => {
    const test = harness({
      codes: { up: 1 },
      state: { tag: "vieux", previousTag: null, deployedAt: "" },
    });
    const result = await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "neuf" }, test.deps);

    assert.equal(result.failure, "démarrage");
    assert.equal(result.health, null);
    // Le retour échoue aussi puisque `up` est cassé : on le dit plutôt que de mentir.
    assert.equal(result.rolledBackTo, null);
    assert.ok(test.logs.some((line) => line.includes("intervention manuelle")));
  });
});

describe("contrôle d'avant-construction, câblé dans up()", () => {
  // Avec un dockerfile : c'est le cas où une construction a lieu, donc celui
  // où l'avertissement doit arriver *avant* — sans dockerfile, `plan.builds`
  // est faux et il n'y a rien à devancer.
  const DEVCONTAINER = parseManifest(`
name = "budget"
[targets.dev]
mode = "devcontainer"
port = 5173
command = "npm run dev"
dockerfile = "Dockerfile.dev"
`);

  /** Une config Vite sans allowedHosts ni host : deux avertissements attendus. */
  const VITE_NU = { "vite.config.ts": "export default { server: { port: 5173 } }" };

  it("prévient avant la construction, pas après", async () => {
    const test = harness({ source: VITE_NU });
    await up({ manifest: DEVCONTAINER, target: "dev", ctx: CTX, tag: "abc" }, test.deps);

    const avis = test.logs.findIndex((l) => l.includes("allowedHosts"));
    const build = test.logs.findIndex((l) => l.includes("construction"));
    assert.ok(avis !== -1, "l'avertissement doit apparaître dans les logs");
    assert.ok(build !== -1 && avis < build, "il ne sert à rien après deux minutes de construction");
  });

  it("n'empêche jamais le déploiement : ce sont des heuristiques", async () => {
    const test = harness({ source: VITE_NU });
    const result = await up({ manifest: DEVCONTAINER, target: "dev", ctx: CTX, tag: "abc" }, test.deps);

    assert.equal(result.ok, true);
    assert.deepEqual(verbs(test.calls), ["build", "up"]);
  });

  it("reste muet quand le projet ne donne aucune prise", async () => {
    const test = harness({});
    await up({ manifest: DEVCONTAINER, target: "dev", ctx: CTX, tag: "abc" }, test.deps);
    assert.ok(!test.logs.some((l) => l.includes("⚠")));
  });

  it("lit bien depuis le dossier source, pas depuis le dossier généré", async () => {
    const chemins: string[] = [];
    const test = harness({});
    const espion = test.deps.readSource;
    test.deps.readSource = async (chemin) => {
      chemins.push(chemin);
      return espion(chemin);
    };
    await up({ manifest: DEVCONTAINER, target: "dev", ctx: CTX, tag: "abc" }, test.deps);

    assert.ok(chemins.length > 0);
    assert.ok(
      chemins.every((c) => c.startsWith(`${CTX.sourcePath}/`)),
      "les chemins sondés doivent partir du dossier source",
    );
  });
});

const HS_DEPLOYED = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
backend = "headscale"
`);

const CTX_HS: Context = {
  ...CTX,
  backend: "headscale",
  headscale: { loginServer: "https://headscale.exemple", certDir: "/certs" },
};

describe("sonde de santé selon le backend", () => {
  it("une cible Headscale est sondée par la sonde dédiée (IP du nœud), jamais par le DNS public", async () => {
    const test = harness({ statuses: [null] }); // le DNS public échouerait…
    let projetVu: string | null = null;
    test.deps.headscaleProbe = (project) => {
      projetVu = project;
      return async () => 200; // …mais la sonde dédiée répond
    };
    const result = await up({ manifest: HS_DEPLOYED, target: "prod", ctx: CTX_HS, tag: "abc" }, test.deps);
    assert.equal(result.ok, true);
    assert.equal(projetVu, "dbox-budget-prod");
  });

  it("une cible Tailscale garde le probe DNS habituel, jamais la sonde Headscale", async () => {
    const test = harness({ statuses: [200] });
    test.deps.headscaleProbe = () => {
      throw new Error("la sonde Headscale ne doit pas servir pour une cible Tailscale");
    };
    const result = await up({ manifest: DEPLOYED, target: "prod", ctx: CTX, tag: "abc" }, test.deps);
    assert.equal(result.ok, true);
  });
});
