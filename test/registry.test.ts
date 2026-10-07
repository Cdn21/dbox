import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Descriptor } from "../src/plan.ts";
import { listDescriptors, parseContainers, PS_FORMAT, scan, since, statusOf } from "../src/registry.ts";

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

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dbox-registry-"));

  const budget: Descriptor = {
    app: "budget",
    target: "prod",
    mode: "deployed",
    hostname: "budget",
    url: "https://budget.mon-tailnet.ts.net",
    healthUrl: "https://budget.mon-tailnet.ts.net/api/session",
    project: "dbox-budget-prod",
    source: "/home/serve/dbox/budget",
    autoDeploy: false,
    publicDomain: null,
    backend: "tailscale",
    services: [],
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

describe("balayage du disque", () => {
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

describe("descripteurs seuls, sans Docker", () => {
  it("lit toutes les cibles, sans avoir besoin de docker ps", async () => {
    const descriptors = await listDescriptors(await fixture());
    assert.deepEqual(
      descriptors.map((d) => d.app).sort(),
      ["budget", "temoin"],
    );
  });

  it("ignore un dossier sans dbox.json, comme le balayage complet", async () => {
    const descriptors = await listDescriptors(await fixture());
    assert.equal(
      descriptors.some((d) => d.app === "autre-chose"),
      false,
    );
  });

  it("rend une liste vide sur une racine inexistante", async () => {
    assert.deepEqual(await listDescriptors("/n/existe/pas"), []);
  });
});

describe("dbox.json écrit par une version antérieure", () => {
  async function ancien(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dbox-ancien-"));
    await mkdir(join(root, "vieille", "prod"), { recursive: true });
    // Ni `services` ni `publicDomain` : le format d'avant. Quatre apps réelles
    // étaient dans ce cas au moment d'écrire ce test.
    await writeFile(
      join(root, "vieille", "prod", "dbox.json"),
      JSON.stringify({
        app: "vieille",
        target: "prod",
        mode: "deployed",
        hostname: "vieille",
        url: "https://vieille.t.net",
        healthUrl: "https://vieille.t.net/",
        project: "dbox-vieille-prod",
        source: "/s",
        autoDeploy: false,
      }),
    );
    return root;
  }

  it("complète les champs absents plutôt que de mentir sur le type", async () => {
    const [entry] = await scan(await ancien(), async () => "");
    assert.deepEqual(entry!.descriptor.services, []);
    assert.equal(entry!.descriptor.publicDomain, null);
  });

  it("les complète aussi pour listDescriptors, que up interroge", async () => {
    const [descriptor] = await listDescriptors(await ancien());
    assert.deepEqual(descriptor!.services, []);
    assert.equal(descriptor!.publicDomain, null);
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

describe("le registre ne croit pas ce qu'annonce un dbox.json", () => {
  async function racineAvec(app: string, target: string, descriptor: Record<string, unknown>): Promise<string> {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const racine = await mkdtemp(`${tmpdir()}/dbox-registre-`);
    await mkdir(`${racine}/${app}/${target}`, { recursive: true });
    await writeFile(`${racine}/${app}/${target}/dbox.json`, JSON.stringify(descriptor));
    return racine;
  }
  const base = { mode: "deployed", hostname: "x", url: "https://x", healthUrl: "https://x/", project: "dbox-x-prod", source: "/s", autoDeploy: false };

  it("garde une entrée cohérente avec son dossier", async () => {
    const racine = await racineAvec("budget", "prod", { ...base, app: "budget", target: "prod" });
    assert.equal((await scan(racine, async () => "")).length, 1);
    assert.equal((await listDescriptors(racine)).length, 1);
  });

  it("écarte un nom qui n'est pas un label DNS : DBox ne l'aurait jamais écrit", async () => {
    const piege = "x')-alert(1)-('";
    const racine = await racineAvec("x", "prod", { ...base, app: piege, target: "prod" });
    assert.deepEqual(await scan(racine, async () => ""), []);
    assert.deepEqual(await listDescriptors(racine), []);
  });

  it("écarte une entrée dont le nom ne correspond pas à son dossier", async () => {
    const racine = await racineAvec("budget", "prod", { ...base, app: "autre", target: "prod" });
    assert.deepEqual(await scan(racine, async () => ""), []);
  });

  it("écarte un dossier au nom invalide, même si dbox.json le recopie", async () => {
    const racine = await racineAvec("Budget", "prod", { ...base, app: "Budget", target: "prod" });
    assert.deepEqual(await scan(racine, async () => ""), []);
  });
});
