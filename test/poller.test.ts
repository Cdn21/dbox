import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Jobs } from "../src/jobs.ts";
import { pollOnce, type PollDeps } from "../src/poller.ts";
import type { Entry } from "../src/registry.ts";
import type { UpResult } from "../src/up.ts";
import type { UpstreamCheck } from "../src/sources.ts";

function entry(over: Partial<Entry["descriptor"]> = {}): Entry {
  return {
    descriptor: {
      app: "budget",
      target: "prod",
      mode: "deployed",
      hostname: "budget",
      url: "https://budget.mon-tailnet.ts.net",
      healthUrl: "https://budget.mon-tailnet.ts.net/",
      project: "dbox-budget-prod",
      source: "/home/serve/dbox/budget",
      autoDeploy: true,
      ...over,
    },
    state: null,
    status: "en marche",
    containers: [],
    directory: "/opt/dbox/apps/budget/prod",
  };
}

function harness(entries: Entry[], checks: Record<string, UpstreamCheck>) {
  const logs: string[] = [];
  const redeployed: string[] = [];
  const jobs = new Jobs(() => 0);

  const deps: PollDeps = {
    scan: async () => entries,
    checkUpstream: async (entry) => checks[entry.descriptor.source] ?? { ok: true, changed: false },
    redeploy: async (target): Promise<UpResult> => {
      redeployed.push(`${target.descriptor.app}/${target.descriptor.target}`);
      return { ok: true } as UpResult;
    },
    jobs,
    log: (line) => logs.push(line),
  };

  return { deps, logs, redeployed, jobs };
}

describe("un cycle de sondage", () => {
  it("ignore les cibles qui n'ont pas activé auto_deploy", async () => {
    const h = harness([entry({ autoDeploy: false })], {});
    await pollOnce(h.deps);
    assert.deepEqual(h.redeployed, []);
  });

  it("ne redéploie rien quand rien n'a changé en amont", async () => {
    const h = harness([entry()], { "/home/serve/dbox/budget": { ok: true, changed: false } });
    await pollOnce(h.deps);
    assert.deepEqual(h.redeployed, []);
  });

  it("redéploie quand l'amont a avancé", async () => {
    const h = harness([entry()], { "/home/serve/dbox/budget": { ok: true, changed: true } });
    await pollOnce(h.deps);
    assert.deepEqual(h.redeployed, ["budget/prod"]);
  });

  it("journalise sans planter quand le fetch échoue", async () => {
    const h = harness([entry()], {
      "/home/serve/dbox/budget": { ok: false, detail: "réseau injoignable" },
    });
    await pollOnce(h.deps);
    assert.deepEqual(h.redeployed, []);
    assert.ok(h.logs.some((line) => line.includes("réseau injoignable")));
  });

  it("ne lance jamais un fetch sur une cible déjà en cours de redéploiement", async () => {
    const h = harness([entry()], { "/home/serve/dbox/budget": { ok: true, changed: true } });
    h.jobs.start("budget/prod"); // un redéploiement manuel, par exemple, déjà en route

    let fetched = false;
    h.deps.checkUpstream = async () => {
      fetched = true;
      return { ok: true, changed: true };
    };

    await pollOnce(h.deps);
    assert.equal(fetched, false);
    assert.deepEqual(h.redeployed, []);
  });

  it("traite plusieurs cibles indépendamment", async () => {
    const h = harness(
      [entry({ app: "budget" }), entry({ app: "temoin", source: "/home/serve/dbox/temoin" })],
      {
        "/home/serve/dbox/budget": { ok: true, changed: true },
        "/home/serve/dbox/temoin": { ok: true, changed: false },
      },
    );
    await pollOnce(h.deps);
    assert.deepEqual(h.redeployed, ["budget/prod"]);
  });
});
