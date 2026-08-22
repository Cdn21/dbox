import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Descriptor } from "../src/plan.ts";
import { parseContainers, PS_FORMAT, scan, since, statusOf } from "../src/registry.ts";

const PS = [
  "dbox-budget-prod|dbox-budget-prod-app-1|running",
  "dbox-budget-prod|dbox-budget-prod-tailscale-1|running",
  "dbox-temoin-prod|dbox-temoin-prod-app-1|exited",
  "dbox-temoin-prod|dbox-temoin-prod-tailscale-1|exited",
  // Un conteneur hors DBox : il n'a pas de projet Compose, on l'ignore.
  "|traefik|running",
  "",
].join("\n");

describe("analyse de docker ps", () => {
  it("demande à Docker le projet, le nom et l'état", () => {
    assert.equal(PS_FORMAT, '{{.Label "com.docker.compose.project"}}|{{.Names}}|{{.State}}');
  });

  it("regroupe par projet et ignore ce qui n'en a pas", () => {
    const byProject = parseContainers(PS);
    assert.deepEqual([...byProject.keys()].sort(), ["dbox-budget-prod", "dbox-temoin-prod"]);
    assert.equal(byProject.get("dbox-budget-prod")?.length, 2);
  });

  it("supporte une sortie vide", () => {
    assert.equal(parseContainers("").size, 0);
  });
});

describe("état d'une cible", () => {
  const c = (state: string) => ({ name: "x", state });

  it("distingue les cinq situations", () => {
    assert.equal(statusOf([]), "jamais démarrée");
    assert.equal(statusOf([c("running"), c("running")]), "en marche");
    assert.equal(statusOf([c("exited"), c("exited")]), "arrêtée");
    assert.equal(statusOf([c("running"), c("exited")]), "partielle");
    // Le symptôme du sidecar qui n'arrive pas à rejoindre le tailnet.
    assert.equal(statusOf([c("running"), c("restarting")]), "redémarre");
  });

  it("signale le redémarrage avant tout le reste", () => {
    assert.equal(statusOf([c("restarting"), c("restarting")]), "redémarre");
  });
});

describe("balayage du disque", () => {
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dbox-registry-"));

    const budget: Descriptor = {
      app: "budget",
      target: "prod",
      mode: "deployed",
      hostname: "budget",
      url: "https://budget.tail4bb652.ts.net",
      healthUrl: "https://budget.tail4bb652.ts.net/api/session",
      project: "dbox-budget-prod",
      source: "/home/serve/dbox/budget",
      autoDeploy: false,
    };
    await mkdir(join(root, "budget", "prod"), { recursive: true });
    await writeFile(join(root, "budget", "prod", "dbox.json"), JSON.stringify(budget));
    await writeFile(
      join(root, "budget", "prod", "state.json"),
      JSON.stringify({ tag: "abc123", previousTag: null, deployedAt: "2026-08-09T20:00:00.000Z" }),
    );

    await mkdir(join(root, "temoin", "prod"), { recursive: true });
    await writeFile(
      join(root, "temoin", "prod", "dbox.json"),
      JSON.stringify({ ...budget, app: "temoin", hostname: "temoin", project: "dbox-temoin-prod" }),
    );

    // Un dossier qui n'est pas une cible DBox : ignoré, sans erreur.
    await mkdir(join(root, "autre-chose", "bidule"), { recursive: true });

    return root;
  }

  it("inventorie les cibles et y attache l'état réel", async () => {
    const entries = await scan(await fixture(), async () => PS);

    assert.deepEqual(
      entries.map((entry) => [entry.descriptor.app, entry.status, entry.state?.tag ?? null]),
      [
        ["budget", "en marche", "abc123"],
        ["temoin", "arrêtée", null],
      ],
    );
  });

  it("ignore un dossier sans dbox.json plutôt que d'échouer", async () => {
    const entries = await scan(await fixture(), async () => PS);
    assert.equal(
      entries.some((entry) => entry.directory.includes("autre-chose")),
      false,
    );
  });

  it("rend une liste vide sur une racine inexistante", async () => {
    assert.deepEqual(await scan("/n/existe/pas", async () => ""), []);
  });
});

describe("ancienneté", () => {
  const now = Date.parse("2026-08-09T21:00:00.000Z");

  it("s'exprime dans l'unité qui se lit", () => {
    assert.equal(since("2026-08-09T20:59:40.000Z", now), "à l'instant");
    assert.equal(since("2026-08-09T20:48:00.000Z", now), "12 min");
    assert.equal(since("2026-08-09T18:00:00.000Z", now), "3 h");
    assert.equal(since("2026-08-07T21:00:00.000Z", now), "2 j");
  });

  it("ne casse pas sur une date illisible", () => {
    assert.equal(since("", now), "—");
  });
});
