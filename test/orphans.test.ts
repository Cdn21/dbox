import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkOrphansOnce, STALE_AFTER_DAYS, type OrphanDeps } from "../src/orphans.ts";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_FILE = "/home/serve/dbox/orphans-report.json";

function harness(overrides: Partial<OrphanDeps> = {}) {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const deps: OrphanDeps = {
    tailnet: "tail4bb652.ts.net",
    tag: "tag:dbox",
    staleAfterMs: STALE_AFTER_DAYS * DAY_MS,
    reportFile: REPORT_FILE,
    readToken: async () => "tskey-api-abc",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    listDevices: async () => [],
    now: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, logs, files };
}

describe("détection des nœuds orphelins (par ancienneté de lastSeen)", () => {
  it("ne signale rien quand tous les nœuds tag:dbox ont été vus récemment", async () => {
    const h = harness({
      listDevices: async () => [
        { id: "1", hostname: "budget", tags: ["tag:dbox"], lastSeen: "2026-08-16T09:00:00Z" },
        { id: "2", hostname: "temoin", tags: ["tag:dbox"], lastSeen: "2026-08-15T09:00:00Z" },
      ],
    });
    await checkOrphansOnce(h.deps);
    assert.match(h.logs.join("\n"), /aucun \(2 nœud/);
  });

  it("ne signale jamais un nœud actif géré par une autre machine — pas de comparaison au registre local", async () => {
    // Le point qui a fait échouer la première version : un nœud « budget »
    // vu à l'instant, mais que la machine qui fait tourner cette vérification
    // ne gère pas elle-même (chaque machine DBox ne gère que ses propres
    // cibles). Aucune notion de registre ici, seulement l'ancienneté.
    const h = harness({
      listDevices: async () => [{ id: "1", hostname: "budget", tags: ["tag:dbox"], lastSeen: "2026-08-16T11:59:00Z" }],
    });
    await checkOrphansOnce(h.deps);
    assert.match(h.logs.join("\n"), /aucun \(1 nœud/);
  });

  it("signale un nœud non vu depuis plus longtemps que le seuil", async () => {
    const h = harness({
      listDevices: async () => [
        { id: "3", hostname: "vieille-app", tags: ["tag:dbox"], lastSeen: "2026-07-01T00:00:00Z" },
      ],
    });
    await checkOrphansOnce(h.deps);
    assert.match(h.logs.join("\n"), /vieille-app \(3\)/);
    assert.match(h.logs.join("\n"), /2026-07-01/);
  });

  it("ne signale pas un nœud tout juste sous le seuil", async () => {
    const h = harness({
      listDevices: async () => [
        { id: "4", hostname: "recent", tags: ["tag:dbox"], lastSeen: new Date(NOW - 13 * DAY_MS).toISOString() },
      ],
    });
    await checkOrphansOnce(h.deps);
    assert.doesNotMatch(h.logs.join("\n"), /recent \(4\)/);
  });

  it("ignore les nœuds sans le tag surveillé, même très anciens", async () => {
    const h = harness({
      listDevices: async () => [
        { id: "5", hostname: "portable-personnel", tags: [], lastSeen: "2020-01-01T00:00:00Z" },
      ],
    });
    await checkOrphansOnce(h.deps);
    assert.match(h.logs.join("\n"), /aucun \(0 nœud/);
  });

  it("n'appelle jamais l'API sans token, et n'écrit pas de rapport", async () => {
    const h = harness({ readToken: async () => "" });
    let called = false;
    h.deps.listDevices = async () => {
      called = true;
      return [];
    };
    await checkOrphansOnce(h.deps);
    assert.equal(called, false);
    assert.match(h.logs.join("\n"), /token.*absent/);
    assert.equal(h.files.has(REPORT_FILE), false);
  });

  it("ne fait rien sans tag configuré, et n'écrit pas de rapport", async () => {
    const h = harness({ tag: null });
    let called = false;
    h.deps.listDevices = async () => {
      called = true;
      return [];
    };
    await checkOrphansOnce(h.deps);
    assert.equal(called, false);
    assert.match(h.logs.join("\n"), /aucun tag configuré/);
    assert.equal(h.files.has(REPORT_FILE), false);
  });

  it("écrit un rapport vide quand rien n'est signalé", async () => {
    const h = harness({
      listDevices: async () => [{ id: "1", hostname: "budget", tags: ["tag:dbox"], lastSeen: "2026-08-16T09:00:00Z" }],
    });
    await checkOrphansOnce(h.deps);
    const report = JSON.parse(h.files.get(REPORT_FILE)!);
    assert.equal(report.checkedAt, new Date(NOW).toISOString());
    // Le tag surveillé est enregistré, pas seulement utilisé pour filtrer —
    // sinon /settings n'aurait aucun moyen de savoir lequel a été vérifié.
    assert.equal(report.tag, "tag:dbox");
    assert.deepEqual(report.stale, []);
  });

  it("écrit le détail des nœuds abandonnés dans le rapport", async () => {
    const h = harness({
      listDevices: async () => [
        { id: "3", hostname: "vieille-app", tags: ["tag:dbox"], lastSeen: "2026-07-01T00:00:00Z" },
      ],
    });
    await checkOrphansOnce(h.deps);
    const report = JSON.parse(h.files.get(REPORT_FILE)!);
    assert.deepEqual(report.stale, [{ hostname: "vieille-app", id: "3", lastSeen: "2026-07-01T00:00:00Z" }]);
  });
});
