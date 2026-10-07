import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isHealthy, waitUntilHealthy, type Probe } from "../src/health.ts";

function clock(step = 1000) {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms: number) => {
      value += ms;
    },
    tick: () => (value += step),
  };
}

function responses(statuses: (number | null)[]): Probe {
  let index = 0;
  return async () => statuses[Math.min(index++, statuses.length - 1)] ?? null;
}

describe("ce qui compte comme vivant", () => {
  it("accepte toute réponse en deçà de 500", () => {
    assert.equal(isHealthy(200), true);
    // Une 404 prouve que la chaîne répond : c'est le routage de l'app, pas le nôtre.
    assert.equal(isHealthy(404), true);
    assert.equal(isHealthy(302), true);
  });

  it("refuse une erreur serveur et l'absence de réponse", () => {
    assert.equal(isHealthy(500), false);
    assert.equal(isHealthy(502), false);
    assert.equal(isHealthy(null), false);
  });
});

describe("attente", () => {
  it("réessaie tant que le nœud ne répond pas encore", async () => {
    const time = clock();
    // Le cas réel du premier démarrage : le certificat met quelques secondes.
    const result = await waitUntilHealthy("https://budget.ts.net/", {
      probe: responses([null, null, 502, 200]),
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: time.sleep,
      now: time.now,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.attempts, 4);
  });

  it("abandonne au délai, en gardant le dernier statut vu", async () => {
    const time = clock();
    const result = await waitUntilHealthy("https://budget.ts.net/", {
      probe: responses([503]),
      timeoutMs: 10_000,
      intervalMs: 3_000,
      sleep: time.sleep,
      now: time.now,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.ok(result.elapsedMs < 10_000, "ne doit pas dépasser le délai imparti");
  });

  it("ne dort jamais après le dernier essai", async () => {
    const time = clock();
    let slept = 0;
    await waitUntilHealthy("https://budget.ts.net/", {
      probe: responses([null]),
      timeoutMs: 6_000,
      intervalMs: 3_000,
      sleep: async (ms) => {
        slept += ms;
        await time.sleep(ms);
      },
      now: time.now,
    });
    assert.equal(slept, 3_000);
  });

  it("réussit du premier coup sans dormir", async () => {
    const time = clock();
    let slept = 0;
    const result = await waitUntilHealthy("https://budget.ts.net/", {
      probe: responses([204]),
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: async (ms) => {
        slept += ms;
        await time.sleep(ms);
      },
      now: time.now,
    });
    assert.equal(result.attempts, 1);
    assert.equal(slept, 0);
  });
});

describe("pinnedHttpProbe : robustesse", () => {
  it("une URL mal formée est injoignable, jamais une exception", async () => {
    const { pinnedHttpProbe } = await import("../src/health.ts");
    assert.equal(await pinnedHttpProbe("127.0.0.1")("pas une url"), null);
  });
});

describe("run : garde-temps", () => {
  it("tue un processus qui dépasse le délai et rend un échec, sans pendre", async () => {
    const { run } = await import("../src/docker.ts");
    const t0 = Date.now();
    const res = await run("sleep", ["5"], { timeoutMs: 80 });
    assert.notEqual(res.code, 0); // tué, donc pas un succès
    assert.ok(Date.now() - t0 < 2000, "doit revenir bien avant les 5 s du sleep");
  });
});
