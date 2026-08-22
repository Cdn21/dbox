import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT, type Context } from "../src/compose.ts";
import type { RunResult } from "../src/docker.ts";
import { parseManifest } from "../src/manifest.ts";
import type { PlannedFile } from "../src/plan.ts";
import { up, type State, type UpDeps } from "../src/up.ts";

const CTX: Context = {
  ...DEFAULT_CONTEXT,
  tailnet: "tail4bb652.ts.net",
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
      readState: async () => harnessed.state,
      writeState: async (_directory, next) => {
        harnessed.state = next;
      },
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
    assert.equal(result.plan.healthUrl, "https://budget.tail4bb652.ts.net/healthz");
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
