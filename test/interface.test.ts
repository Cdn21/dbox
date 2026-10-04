import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Jobs } from "../src/jobs.ts";
import { ACTION_HEADER } from "../src/protocol.ts";
import type { Entry } from "../src/registry.ts";
import { route, type Actions, type Deps } from "../src/server.ts";
import type { UpResult } from "../src/up.ts";

// Les améliorations de l'interface du 4 octobre 2026 — une par describe, dans
// l'ordre de la liste qui les a décidées.

const NOW = Date.parse("2026-10-04T07:00:00.000Z");
const MOI = { "tailscale-user-login": "moi@exemple.fr" };
const AGIR = { ...MOI, [ACTION_HEADER]: "1" };

function entry(over: Partial<Entry["descriptor"]> = {}, state: Entry["state"] = null): Entry {
  const app = over.app ?? "budget";
  const target = over.target ?? "prod";
  return {
    descriptor: {
      app,
      target,
      mode: "deployed",
      hostname: app,
      url: `https://${app}.mon-tailnet.ts.net`,
      healthUrl: `https://${app}.mon-tailnet.ts.net/`,
      project: `dbox-${app}-${target}`,
      source: `/srv/${app}`,
      autoDeploy: false,
      publicDomain: null,
      services: [],
      ...over,
    },
    state,
    status: "en marche",
    containers: [],
    directory: `/opt/dbox/apps/${app}/${target}`,
  };
}

function harnais(entries: Entry[], fichiers: Record<string, string> = {}) {
  const ajouts: unknown[][] = [];
  const pending = new Promise<UpResult>(() => {});
  const actions: Actions = {
    compose: async (_d, args) => ({
      code: 0,
      stdout: args[0] === "logs" ? "démarrage\nERREUR base injoignable\nprêt\n" : "",
      stderr: "",
    }),
    jobs: new Jobs(() => NOW),
    redeploy: () => pending,
    remove: async () => ({ code: 0, stdout: "", stderr: "" }),
    add: (url, name, _log, choice) => {
      ajouts.push(["git", url, name, choice]);
      return pending;
    },
    addLocal: (path, _log, choice) => {
      ajouts.push(["local", path, choice]);
      return pending;
    },
    readFile: async (path) => {
      const found = fichiers[path];
      if (found === undefined) throw new Error("absent");
      return found;
    },
    writeFile: async () => {},
  };
  const deps: Deps = { scan: async () => entries, now: () => NOW, actions, workspacesRoot: "/espaces" };
  return { deps, ajouts };
}

const corps = (champs: Record<string, string>) => new URLSearchParams(champs).toString();

describe("1. couper une cible déployée demande confirmation", () => {
  it("Arrêter et Redémarrer confirment en prod, pas Redéployer", async () => {
    const { deps } = harnais([entry()]);
    const page = (await route("GET", "/", MOI, deps)).body;
    assert.match(page, /hx-post="\/api\/apps\/budget\/prod\/stop"[^>]*hx-confirm="Arrêter budget\/prod/);
    assert.match(page, /hx-post="\/api\/apps\/budget\/prod\/restart"[^>]*hx-confirm="Redémarrer budget\/prod/);
    assert.doesNotMatch(page, /hx-post="\/api\/apps\/budget\/prod\/up"[^>]*hx-confirm/);
  });

  it("une cible de dev reste sans friction", async () => {
    const { deps } = harnais([entry({ target: "dev", mode: "devcontainer" })]);
    const page = (await route("GET", "/", MOI, deps)).body;
    assert.doesNotMatch(page, /hx-confirm="Arrêter/);
  });
});

describe("2. recharger la page garde le suivi d'un redéploiement", () => {
  it("la carte remontre la tâche en cours et grise ses actions", async () => {
    const { deps } = harnais([entry()]);
    await route("POST", "/api/apps/budget/prod/up", AGIR, deps);

    for (const chemin of ["/", "/api/apps/list"]) {
      const html = (await route("GET", chemin, MOI, deps)).body;
      assert.match(html, /<div id="sortie-budget-prod"[^>]*><div class="job" hx-get="\/api\/jobs\/\d+"/, chemin);
      assert.match(html, /class="redeployer"[^>]*disabled title="redéploiement en cours"/, chemin);
    }
  });

  it("sans tâche, rien n'est grisé", async () => {
    const { deps } = harnais([entry()]);
    const html = (await route("GET", "/api/apps/list", MOI, deps)).body;
    assert.doesNotMatch(html, /disabled title="redéploiement en cours"/);
    assert.doesNotMatch(html, /class="job"/);
  });
});

describe("4. la version déployée renvoie à son commit", () => {
  it("lien vers la forge et retard local de la source", async () => {
    const { deps } = harnais([entry({}, { tag: "abc1234", previousTag: null, deployedAt: "2026-10-01T00:00:00Z" })]);
    deps.versionInfo = async () => ({ commitUrl: "https://forge/moi/budget/commit/abc1234", nonDeployes: 2 });
    const html = (await route("GET", "/api/apps/list", MOI, deps)).body;
    assert.match(html, /<a class="commit" href="https:\/\/forge\/moi\/budget\/commit\/abc1234">abc1234<\/a>/);
    assert.match(html, /source : 2 commits non déployés/);
  });

  it("une erreur de calcul ne casse pas la page", async () => {
    const { deps } = harnais([entry({}, { tag: "abc1234", previousTag: null, deployedAt: "2026-10-01T00:00:00Z" })]);
    deps.versionInfo = async () => {
      throw new Error("git absent");
    };
    const reponse = await route("GET", "/", MOI, deps);
    assert.equal(reponse.status, 200);
    assert.match(reponse.body, /abc1234/);
  });
});

describe("5. revenir sur l'onglet rafraîchit tout de suite", () => {
  it("le sondage écoute aussi visibilitychange, avec la même garde", async () => {
    const { deps } = harnais([entry()]);
    const page = (await route("GET", "/", MOI, deps)).body;
    assert.match(page, /hx-trigger="every 15s \[[^\]]+\], visibilitychange\[[^\]]+\] from:document"/);
  });
});

describe("6. les journaux se filtrent", () => {
  it("le serveur ne garde que les lignes qui contiennent le filtre, sans regex", async () => {
    const { deps } = harnais([entry()]);
    const html = (await route("GET", "/api/apps/budget/prod/logs", MOI, deps, new URLSearchParams("q=erreur"))).body;
    assert.match(html, /<pre>ERREUR base injoignable<\/pre>/);
    assert.match(html, /value="erreur"/);
    assert.match(html, /hx-preserve="true"/);
  });

  it("dit qu'aucune ligne ne correspond plutôt que d'afficher un bloc vide", async () => {
    const { deps } = harnais([entry()]);
    const html = (await route("GET", "/api/apps/budget/prod/logs", MOI, deps, new URLSearchParams("q=.*"))).body;
    assert.match(html, /aucune ligne ne contient « \.\* »/);
  });
});

describe("7. l'accueil rappelle ce qui attend un geste", () => {
  it("nœuds abandonnés et tag manquant, en une ligne vers les Réglages", async () => {
    const { deps } = harnais([entry()]);
    deps.orphansReport = async () => ({
      checkedAt: "2026-10-04T00:00:00Z",
      tag: "tag:dbox",
      stale: [
        { hostname: "a", id: "1", lastSeen: "2026-08-01T00:00:00Z" },
        { hostname: "b", id: "2", lastSeen: "2026-08-01T00:00:00Z" },
      ],
    });
    deps.tagReport = async () => ({ checkedAt: "2026-10-04T00:00:00Z", tag: "tag:dbox", present: false, suggestedLine: "x" });
    const page = (await route("GET", "/", MOI, deps)).body;
    assert.match(page, /class="avis avis-doux rappel">2 nœuds Tailscale[^<]*tag:dbox manque dans tagOwners[^<]*<a href="\/settings">/);
  });

  it("rien quand tout va bien", async () => {
    const { deps } = harnais([entry()]);
    deps.orphansReport = async () => ({ checkedAt: "2026-10-04T00:00:00Z", tag: "tag:dbox", stale: [] });
    deps.tagReport = async () => ({ checkedAt: "2026-10-04T00:00:00Z", tag: "tag:dbox", present: true, suggestedLine: null });
    assert.doesNotMatch((await route("GET", "/", MOI, deps)).body, /class="avis avis-doux rappel"/);
  });
});

describe("8. l'état des bascules se lit aussi sans les voir", () => {
  it("les panneaux portent aria-pressed et aria-controls, la sortie est annoncée", async () => {
    const { deps } = harnais([entry()]);
    const page = (await route("GET", "/", MOI, deps)).body;
    assert.match(page, /data-action="env"[^>]*aria-controls="panneau-budget-prod"[^>]*:aria-pressed=/);
    assert.match(page, /<div id="sortie-budget-prod" role="status" aria-live="polite">/);
  });
});

describe("9. le formulaire d'ajout montre le dbox.toml avant de cliquer", () => {
  const apercu = async (deps: Deps, champs: Record<string, string>) =>
    (await route("GET", "/api/apps/apercu", MOI, deps, new URLSearchParams(champs))).body;

  it("dev depuis git : le squelette exact, avec la réserve du manifeste existant", async () => {
    const { deps } = harnais([]);
    const html = await apercu(deps, { source: "git", url: "git@github.com:moi/mon-app.git", mode: "workspace", port: "5173", command: "npm run dev" });
    assert.match(html, /name = &quot;mon-app&quot;/);
    assert.match(html, /\[targets\.dev\]/);
    assert.match(html, /port = 5173/);
    assert.match(html, /sauf si le dépôt a déjà son propre dbox\.toml/);
  });

  it("prod depuis git : dit ce qui sera déduit, sans inventer de port", async () => {
    const { deps } = harnais([]);
    const html = await apercu(deps, { source: "git", url: "git@github.com:moi/mon-app.git", mode: "deployed" });
    assert.doesNotMatch(html, /<pre>/);
    assert.match(html, /déduit du Dockerfile du dépôt après clonage/);
  });

  it("dossier local qui a déjà son dbox.toml : montré tel quel, le formulaire n'y change rien", async () => {
    const { deps } = harnais([], { "/espaces/projet/dbox.toml": 'name = "projet"\n' });
    const html = await apercu(deps, { source: "local", path: "projet", mode: "workspace", port: "3000", command: "x" });
    assert.match(html, /name = &quot;projet&quot;/);
    assert.match(html, /utilisé tel quel/);
  });

  it("dossier local en prod : déduit du Dockerfile, ou dit qu'il en manque un", async () => {
    const avec = harnais([], { "/espaces/projet/Dockerfile": "FROM nginx\nEXPOSE 8080\n" });
    assert.match(await apercu(avec.deps, { source: "local", path: "projet", mode: "deployed" }), /port = 8080/);
    const sans = harnais([]);
    assert.match(await apercu(sans.deps, { source: "local", path: "projet", mode: "deployed" }), /pas de Dockerfile/);
  });

  it("attend un champ vide sans le reprocher", async () => {
    const { deps } = harnais([]);
    const html = await apercu(deps, { source: "git", url: "x", mode: "workspace", port: "", command: "" });
    assert.match(html, /indique le port et la commande/);
    assert.doesNotMatch(html, /invalide/);
  });

  it("refuse de sortir de la racine, et signale un port invalide", async () => {
    const { deps } = harnais([]);
    assert.doesNotMatch(await apercu(deps, { source: "local", path: "../etc", mode: "deployed" }), /<pre>/);
    assert.match(await apercu(deps, { source: "git", url: "x", mode: "workspace", port: "0", command: "x" }), /port invalide/);
  });
});

describe("l'aperçu se pose dans son propre bloc", () => {
  it("cible lui-même, pas la zone de résultats héritée du formulaire", async () => {
    const { renderAjout } = await import("../src/ui/ajout.ts");
    const html = renderAjout("/espaces", []);
    // htmx hérite hx-target des ancêtres : sans ce « this », l'aperçu
    // remplaçait le résultat de l'ajout dans #sortie-ajout. Vu au banc d'essai.
    assert.match(html, /class="apercu" hx-get="\/api\/apps\/apercu"[^>]*hx-target="this"/);
    assert.match(html, /hx-trigger="load, change from:closest form, input delay:500ms from:closest form"/);
    assert.doesNotMatch(html, /changed[^"]*from:closest form/);
  });
});

describe("le formulaire ajoute la source qu'il montre", () => {
  it("revenir à « Dépôt git » après avoir choisi un dossier clone bien l'URL", async () => {
    const { deps, ajouts } = harnais([]);
    await route("POST", "/api/apps", AGIR, deps, undefined, corps({ source: "git", url: "git@github.com:moi/app.git", path: "projet", mode: "deployed" }));
    assert.equal(ajouts.length, 1);
    assert.equal(ajouts[0]![0], "git");
    assert.equal(ajouts[0]![1], "git@github.com:moi/app.git");
  });

  it("et un dossier local ignore une URL restée dans le champ caché", async () => {
    const { deps, ajouts } = harnais([]);
    await route("POST", "/api/apps", AGIR, deps, undefined, corps({ source: "local", url: "git@github.com:moi/app.git", path: "projet", mode: "deployed" }));
    assert.deepEqual(ajouts[0]!.slice(0, 2), ["local", "projet"]);
  });
});

describe("mobile", () => {
  it("le panneau Variables ne peut plus déborder : colonne minmax(0, 1fr)", async () => {
    const { STYLE } = await import("../src/ui/chrome.ts");
    assert.match(STYLE, /\.conf \{[^}]*grid-template-columns:minmax\(0, 1fr\)/);
    assert.match(STYLE, /header \{[^}]*flex-wrap:wrap/);
    // Les règles mobiles des bascules doivent l'emporter sur la règle générale
    // déclarée plus bas, et sur la règle tactile : d'où le « .actions » devant.
    // Sans lui, elles étaient silencieusement écrasées — vu au banc d'essai.
    assert.match(STYLE, /\.actions \.secondaires \{ display:grid; grid-template-columns:repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(STYLE, /\.actions \.secondaires button \{ min-width:0;/);
  });
});
