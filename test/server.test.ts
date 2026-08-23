import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../src/docker.ts";
import { Jobs } from "../src/jobs.ts";
import { renderPage, renderSettingsPage } from "../src/page.ts";
import { ACTION_HEADER } from "../src/protocol.ts";
import type { Entry } from "../src/registry.ts";
import { route, viewerOf, type Actions, type Deps } from "../src/server.ts";
import type { UpResult } from "../src/up.ts";

const NOW = Date.parse("2026-08-10T07:00:00.000Z");
const MOI = { "tailscale-user-login": "moi@exemple.fr" };
const AGIR = { ...MOI, [ACTION_HEADER]: "1" };
const HTMX = { ...AGIR, "hx-request": "true" };

/** Le corps d'un formulaire htmx : `application/x-www-form-urlencoded`, pas
 * du JSON — les routes d'action lisent `URLSearchParams` depuis cette
 * version de la migration htmx. */
function form(fields: Record<string, string | number>): string {
  return new URLSearchParams(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]))).toString();
}

function entry(
  over: Partial<Entry["descriptor"]> = {},
  state: Entry["state"] = null,
  status: Entry["status"] = "en marche",
): Entry {
  return {
    descriptor: {
      app: "budget",
      target: "prod",
      mode: "deployed",
      hostname: "budget",
      url: "https://budget.mon-tailnet.ts.net",
      healthUrl: "https://budget.mon-tailnet.ts.net/api/session",
      project: "dbox-budget-prod",
      source: "/home/serve/dbox/budget",
      autoDeploy: false,
      ...over,
    },
    state,
    status,
    containers: [],
    directory: "/opt/dbox/apps/budget/prod",
  };
}

const lecture = (entries: Entry[]): Deps => ({ scan: async () => entries, now: () => NOW });

interface Harness {
  deps: Deps;
  calls: string[][];
  addCalls: unknown[][];
  addLocalCalls: unknown[][];
  removeCalls: Entry[];
  resolve: (result: UpResult) => void;
  fichiers: Map<string, string>;
}

function avecActions(entries: Entry[], code = 0): Harness {
  const calls: string[][] = [];
  const addCalls: unknown[][] = [];
  const addLocalCalls: unknown[][] = [];
  const removeCalls: Entry[] = [];
  let resolve!: (result: UpResult) => void;
  const pending = new Promise<UpResult>((done) => (resolve = done));

  const fichiers = new Map<string, string>([["/opt/dbox/apps/budget/prod/.env", "A=1\nB=deux\n"]]);

  const actions: Actions = {
    compose: async (_directory, args): Promise<RunResult> => {
      calls.push(args);
      return { code, stdout: args[0] === "logs" ? "journal ligne 1\n" : "", stderr: code === 0 ? "" : "boum" };
    },
    jobs: new Jobs(() => NOW),
    redeploy: () => pending,
    remove: async (entry) => {
      removeCalls.push(entry);
      return { code, stdout: "", stderr: code === 0 ? "" : "boum" };
    },
    add: (url, name, _log, choice) => {
      addCalls.push([url, name, choice]);
      return pending;
    },
    addLocal: (path, _log, choice) => {
      addLocalCalls.push([path, choice]);
      return pending;
    },
    readFile: async (path) => {
      const found = fichiers.get(path);
      if (found === undefined) throw new Error("absent");
      return found;
    },
    writeFile: async (path, content) => {
      fichiers.set(path, content);
    },
  };

  return {
    deps: { scan: async () => entries, now: () => NOW, actions },
    calls,
    addCalls,
    addLocalCalls,
    removeCalls,
    resolve,
    fichiers,
  };
}

/** Le numéro de tâche affiché dans le fragment de sondage htmx. */
function jobIdFrom(body: string): string {
  const found = /\/api\/jobs\/(\S+?)"/.exec(body);
  assert.ok(found, `aucun identifiant de tâche dans : ${body}`);
  return found[1]!;
}

describe("identité de l'appelant", () => {
  it("se lit dans les en-têtes posés par tailscale serve", () => {
    assert.equal(viewerOf(MOI), "moi@exemple.fr");
    assert.equal(viewerOf({ "tailscale-user-name": "Alex" }), "Alex");
  });

  it("vaut null quand ils sont absents ou vides", () => {
    assert.equal(viewerOf({}), null);
    assert.equal(viewerOf({ "tailscale-user-login": "" }), null);
  });
});

describe("accès", () => {
  it("refuse tout sans identité : le seul chemin est le sidecar", async () => {
    for (const path of ["/", "/api/apps"]) {
      const response = await route("GET", path, {}, lecture([entry()]));
      assert.equal(response.status, 401);
    }
  });

  it("laisse passer /health sans identité ni registre", async () => {
    let scanned = false;
    const response = await route("GET", "/health", {}, {
      scan: async () => {
        scanned = true;
        return [];
      },
      now: () => NOW,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "ok\n");
    // C'est ce que le conteneur interroge sur lui-même : ça ne doit dépendre de rien.
    assert.equal(scanned, false);
  });

  it("exige l'en-tête maison sur toute écriture", async () => {
    // Sans lui, un formulaire d'un site tiers déclencherait un déploiement :
    // l'identité est injectée par le proxy, donc présente sur une requête croisée.
    const harness = avecActions([entry()]);
    const response = await route("POST", "/api/apps/budget/prod/stop", MOI, harness.deps);
    assert.equal(response.status, 400);
    assert.match(response.body, new RegExp(ACTION_HEADER));
    assert.deepEqual(harness.calls, []);
  });

  it("répond 405 aux écritures quand le daemon est en lecture seule", async () => {
    const response = await route("POST", "/api/apps/budget/prod/stop", AGIR, lecture([entry()]));
    assert.equal(response.status, 405);
    assert.equal(response.headers["allow"], "GET, HEAD");
  });
});

describe("lecture", () => {
  it("sert la page à la racine", async () => {
    const response = await route("GET", "/", MOI, lecture([entry()]));
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"]!, /text\/html/);
    assert.match(response.body, /budget/);
  });

  it("expose l'inventaire en JSON", async () => {
    const state = { tag: "abc123", previousTag: null, deployedAt: "2026-08-10T06:00:00.000Z" };
    const response = await route("GET", "/api/apps", MOI, lecture([entry({}, state)]));
    const [first] = JSON.parse(response.body);
    assert.equal(first.app, "budget");
    assert.equal(first.status, "en marche");
    assert.deepEqual(first.state, state);
  });

  it("rend juste la liste des cartes, en fragment htmx, sondé par /", async () => {
    const response = await route("GET", "/api/apps/list", MOI, lecture([entry()]));
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"]!, /text\/html/);
    assert.match(response.body, /budget/);
    assert.doesNotMatch(response.body, /<!doctype html>/);
    assert.doesNotMatch(response.body, /class="ajout"/);
  });

  it("rend les journaux d'une cible, dans un <pre>", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /<pre>journal ligne 1\n?<\/pre>/);
    assert.deepEqual(harness.calls, [["logs", "--no-color", "--tail=200"]]);
  });

  it("borne le nombre de lignes demandé", async () => {
    const harness = avecActions([entry()]);
    await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps, new URLSearchParams("lines=999999"));
    assert.deepEqual(harness.calls, [["logs", "--no-color", "--tail=2000"]]);
  });

  it("échappe le contenu d'un journal avant de l'insérer en HTML", async () => {
    const harness = avecActions([entry()], 0);
    harness.deps.actions!.compose = async (_directory, args) => {
      harness.calls.push(args);
      return { code: 0, stdout: "<script>alert(1)</script>\n", stderr: "" };
    };
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.doesNotMatch(response.body, /<script>alert/);
    assert.match(response.body, /&lt;script&gt;/);
  });

  it("renvoie 404 sur une cible inconnue", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/inexistante/prod/logs", MOI, harness.deps);
    assert.equal(response.status, 404);
  });
});

describe("actions", () => {
  it("arrête et démarre par la commande qu'on taperait à la main", async () => {
    for (const [action, verb] of [["stop", "stop"], ["start", "start"]]) {
      const harness = avecActions([entry()]);
      const response = await route("POST", `/api/apps/budget/prod/${action}`, AGIR, harness.deps);
      assert.equal(response.status, 200);
      assert.deepEqual(harness.calls, [[verb!]]);
      assert.match(response.body, /<pre>fait<\/pre>/);
      // Un succès qui change l'affichage (statut, boutons) recharge la page.
      assert.match(response.body, /location\.reload/);
    }
  });

  it("remonte l'échec de Docker dans le fragment, sans recharger", async () => {
    const harness = avecActions([entry()], 1);
    const response = await route("POST", "/api/apps/budget/prod/stop", AGIR, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /<pre>boum<\/pre>/);
    assert.doesNotMatch(response.body, /location\.reload/);
  });

  it("supprime une cible via actions.remove, puis recharge", async () => {
    const harness = avecActions([entry()]);
    const response = await route("POST", "/api/apps/budget/prod/remove", AGIR, harness.deps);
    assert.equal(response.status, 200);
    assert.equal(harness.removeCalls.length, 1);
    assert.equal(harness.removeCalls[0]!.descriptor.app, "budget");
    assert.match(response.body, /<pre>supprimée<\/pre>/);
    assert.match(response.body, /location\.reload/);
  });

  it("remonte l'échec de la suppression, sans recharger", async () => {
    const harness = avecActions([entry()], 1);
    const response = await route("POST", "/api/apps/budget/prod/remove", AGIR, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /<pre>boum<\/pre>/);
    assert.doesNotMatch(response.body, /location\.reload/);
  });

  it("refuse de supprimer une cible en cours de redéploiement", async () => {
    const harness = avecActions([entry()]);
    await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);

    const response = await route("POST", "/api/apps/budget/prod/remove", AGIR, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /redéploiement est en cours/);
    assert.equal(harness.removeCalls.length, 0);
  });

  it("rend la main tout de suite sur un redéploiement, avec un fragment de sondage", async () => {
    const harness = avecActions([entry()]);
    const response = await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);

    assert.equal(response.status, 200);
    assert.match(response.body, /hx-trigger="every 1500ms"/);
    const jobId = jobIdFrom(response.body);
    const job = await route("GET", `/api/jobs/${jobId}`, MOI, harness.deps);
    assert.equal(JSON.parse(job.body).status, "en cours");
  });

  it("le sondage htmx du job rend un fragment, pas du JSON", async () => {
    const harness = avecActions([entry()]);
    const started = await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);
    const jobId = jobIdFrom(started.body);

    const poll = await route("GET", `/api/jobs/${jobId}`, HTMX, harness.deps);
    assert.match(poll.headers["content-type"]!, /text\/html/);
    assert.match(poll.body, /hx-trigger="every 1500ms"/);
  });

  it("un second clic pendant un redéploiement montre le même job en cours, pas une erreur", async () => {
    const harness = avecActions([entry()]);
    const first = await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);
    const second = await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);

    assert.equal(second.status, 200);
    assert.equal(jobIdFrom(first.body), jobIdFrom(second.body));
  });

  it("marque la tâche selon le résultat du déploiement, et arrête le sondage une fois finie", async () => {
    const harness = avecActions([entry()]);
    const started = await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);
    const jobId = jobIdFrom(started.body);

    harness.resolve({ ok: false } as UpResult);
    await new Promise((done) => setImmediate(done));

    const job = await route("GET", `/api/jobs/${jobId}`, MOI, harness.deps);
    assert.equal(JSON.parse(job.body).status, "échoué");

    const fragment = await route("GET", `/api/jobs/${jobId}`, HTMX, harness.deps);
    // Terminée : plus d'attribut de sondage, htmx s'arrête de lui-même.
    assert.doesNotMatch(fragment.body, /hx-trigger/);
  });

  it("refuse une action inconnue", async () => {
    const harness = avecActions([entry()]);
    const response = await route("POST", "/api/apps/budget/prod/danser", AGIR, harness.deps);
    assert.equal(response.status, 404);
  });
});

describe("clé SSH dédiée", () => {
  function avecCle(status: { exists: boolean; publicKey: string | null }, peutGenerer = true) {
    const h = avecActions([entry()]);
    let etat = status;
    h.deps.sshKeyStatus = async () => etat;
    if (peutGenerer) {
      // Une vraie génération change ce qu'un statut lu ensuite renvoie — le
      // mock doit refléter ça, sans quoi le panneau rendu après coup montrerait
      // encore l'absence de clé.
      h.deps.actions!.generateSshKey = async () => {
        etat = { exists: true, publicKey: "ssh-ed25519 AAAA dbox" };
        return { created: true, publicKey: "ssh-ed25519 AAAA dbox" };
      };
    }
    return h;
  }

  it("404 quand la machine n'a pas de clé configurée", async () => {
    const response = await route("GET", "/api/ssh-key", MOI, avecActions([entry()]).deps);
    assert.equal(response.status, 404);
  });

  it("rend l'absence de clé", async () => {
    const h = avecCle({ exists: false, publicKey: null });
    const response = await route("GET", "/api/ssh-key", MOI, h.deps);
    assert.deepEqual(JSON.parse(response.body), { exists: false, publicKey: null });
  });

  it("rend la clé publique quand elle existe — jamais la privée, elle n'existe même pas ici", async () => {
    const h = avecCle({ exists: true, publicKey: "ssh-ed25519 AAAA dbox" });
    const response = await route("GET", "/api/ssh-key", MOI, h.deps);
    assert.deepEqual(JSON.parse(response.body), { exists: true, publicKey: "ssh-ed25519 AAAA dbox" });
  });

  it("génère à la demande, avec l'en-tête maison, et rend le panneau à jour", async () => {
    const h = avecCle({ exists: false, publicKey: null });
    const response = await route("POST", "/api/ssh-key", AGIR, h.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /ssh-ed25519 AAAA dbox/);
  });

  it("refuse de générer sans l'en-tête maison", async () => {
    const h = avecCle({ exists: false, publicKey: null });
    const response = await route("POST", "/api/ssh-key", MOI, h.deps);
    assert.equal(response.status, 400);
  });

  it("404 si la machine ne sait pas générer de clé", async () => {
    const h = avecCle({ exists: false, publicKey: null }, false);
    const response = await route("POST", "/api/ssh-key", AGIR, h.deps);
    assert.equal(response.status, 404);
  });
});

describe("clé SSH par app", () => {
  function avecCleApp(status: { exists: boolean; publicKey: string | null }, peutGenerer = true) {
    const h = avecActions([entry()]);
    let etat = status;
    h.deps.appSshKeyStatus = async () => etat;
    if (peutGenerer) {
      h.deps.actions!.generateAppSshKey = async () => {
        etat = { exists: true, publicKey: "ssh-ed25519 AAAA budget" };
        return { created: true, publicKey: "ssh-ed25519 AAAA budget" };
      };
    }
    return h;
  }

  it("404 quand la machine ne gère pas les clés par app", async () => {
    const response = await route("GET", "/api/apps/budget/ssh-key", MOI, avecActions([entry()]).deps);
    assert.equal(response.status, 404);
  });

  it("rend le statut de la clé de cette app précisément", async () => {
    const h = avecCleApp({ exists: false, publicKey: null });
    const response = await route("GET", "/api/apps/budget/ssh-key", MOI, h.deps);
    assert.deepEqual(JSON.parse(response.body), { exists: false, publicKey: null });
  });

  it("génère à la demande, avec l'en-tête maison, et rend le fragment à jour", async () => {
    const h = avecCleApp({ exists: false, publicKey: null });
    const response = await route("POST", "/api/apps/budget/ssh-key", AGIR, h.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /ssh-ed25519 AAAA budget/);
  });

  it("refuse de générer sans l'en-tête maison", async () => {
    const h = avecCleApp({ exists: false, publicKey: null });
    const response = await route("POST", "/api/apps/budget/ssh-key", MOI, h.deps);
    assert.equal(response.status, 400);
  });

  it("404 si la machine ne sait pas générer de clé par app", async () => {
    const h = avecCleApp({ exists: false, publicKey: null }, false);
    const response = await route("POST", "/api/apps/budget/ssh-key", AGIR, h.deps);
    assert.equal(response.status, 404);
  });
});

describe("ajouter une app", () => {
  it("rend la main tout de suite et suit la tâche", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "git@github.com:Moi/monApp.git" }),
    );

    assert.equal(response.status, 200);
    const jobId = jobIdFrom(response.body);
    const job = await route("GET", `/api/jobs/${jobId}`, MOI, harness.deps);
    assert.equal(JSON.parse(job.body).status, "en cours");
  });

  it("refuse une url et un chemin manquants", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ name: "x" }),
    );
    assert.equal(response.status, 200);
    assert.match(response.body, /url ou chemin manquant/);
  });

  it("exige l'en-tête maison, comme toute écriture", async () => {
    const harness = avecActions([entry()]);
    const response = await route("POST", "/api/apps", MOI, harness.deps, new URLSearchParams(), form({ url: "x" }));
    assert.equal(response.status, 400);
    assert.match(response.body, new RegExp(ACTION_HEADER));
  });

  it("le dit quand la machine n'est pas configurée pour cloner", async () => {
    const harness = avecActions([entry()]);
    delete (harness.deps.actions as { add?: unknown }).add;
    const response = await route("POST", "/api/apps", AGIR, harness.deps, new URLSearchParams(), form({ url: "x" }));
    assert.match(response.body, /n'est pas configurée pour cloner/);
  });

  it("un chemin passe par addLocal, pas par le clonage", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ path: "mon-projet" }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(harness.addLocalCalls, [["mon-projet", undefined]]);
    assert.deepEqual(harness.addCalls, []);
  });

  it("un chemin prime sur une url fournie en même temps", async () => {
    const harness = avecActions([entry()]);
    await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ path: "mon-projet", url: "git@github.com:x/y.git" }),
    );
    assert.deepEqual(harness.addLocalCalls, [["mon-projet", undefined]]);
    assert.deepEqual(harness.addCalls, []);
  });

  it("le dit quand la machine n'a pas de racine de dossiers locaux", async () => {
    const harness = avecActions([entry()]);
    delete (harness.deps.actions as { addLocal?: unknown }).addLocal;
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ path: "mon-projet" }),
    );
    assert.match(response.body, /n'est pas configurée pour ajouter un dossier local/);
  });

  it("sans mode (ou « deployed »), laisse deviner le squelette depuis le Dockerfile", async () => {
    const harness = avecActions([entry()]);
    await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "git@github.com:Moi/monApp.git", mode: "deployed" }),
    );
    // « deployed » choisi explicitement revient au même que ne rien choisir :
    // c'est le seul mode qui se devine, choice reste absent dans les deux cas.
    assert.deepEqual(harness.addCalls, [["git@github.com:Moi/monApp.git", null, undefined]]);
  });

  it("transmet le mode, le port et la commande choisis par le formulaire", async () => {
    const harness = avecActions([entry()]);
    await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "workspace", port: 5178, command: "npm run dev" }),
    );
    assert.deepEqual(harness.addCalls, [["x", null, { mode: "workspace", port: 5178, command: "npm run dev" }]]);
  });

  it("refuse un mode inconnu", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "prod", port: 8080, command: "x" }),
    );
    assert.match(response.body, /mode inconnu/);
  });

  it("refuse un port hors bornes", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "workspace", port: 99999, command: "x" }),
    );
    assert.match(response.body, /port/);
  });

  it("refuse workspace/devcontainer sans commande", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "devcontainer", port: 3000 }),
    );
    assert.match(response.body, /commande manquante/);
  });

  it("n'exige pas de commande en deployed", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "deployed" }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(harness.addCalls, [["x", null, undefined]]);
  });
});

describe("liste des dossiers locaux sur la page", () => {
  it("apparaît quand addLocal et listWorkspaces sont tous les deux configurés", async () => {
    const harness = avecActions([entry()]);
    harness.deps.workspacesRoot = "/home/cde/dev";
    harness.deps.listWorkspaces = async () => [
      { name: "budget", command: null },
      { name: "temoin", command: null },
    ];
    const response = await route("GET", "/", MOI, harness.deps);
    assert.match(response.body, /<option value="budget">budget<\/option>/);
  });

  it("n'apparaît pas si la machine ne sait pas ajouter de dossier local, même avec une liste", async () => {
    const harness = avecActions([entry()]);
    delete (harness.deps.actions as { addLocal?: unknown }).addLocal;
    harness.deps.workspacesRoot = "/home/cde/dev";
    harness.deps.listWorkspaces = async () => [{ name: "budget", command: null }];
    const response = await route("GET", "/", MOI, harness.deps);
    assert.doesNotMatch(response.body, /<option value="budget">budget<\/option>/);
  });
});

describe("configuration d'une cible", () => {
  it("rend les variables du .env dans le panneau", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/env", MOI, harness.deps);
    assert.match(response.headers["content-type"]!, /text\/html/);
    assert.match(response.body, /&quot;a&quot;:&quot;A&quot;,&quot;b&quot;:&quot;1&quot;/);
    assert.match(response.body, /&quot;a&quot;:&quot;B&quot;,&quot;b&quot;:&quot;deux&quot;/);
  });

  it("rend une seule ligne vide quand le fichier n'existe pas", async () => {
    const temoin = entry({ app: "temoin" });
    temoin.directory = "/opt/dbox/apps/temoin/prod";
    const harness = avecActions([temoin]);
    const response = await route("GET", "/api/apps/temoin/prod/env", MOI, harness.deps);
    assert.match(response.body, /&quot;a&quot;:&quot;&quot;,&quot;b&quot;:&quot;&quot;/);
  });

  it("échappe une valeur hostile sans casser l'attribut x-data qui la porte", async () => {
    // Le panneau embarque le .env en JSON dans un attribut HTML (x-data) — le
    // point le plus délicat de la migration htmx/Alpine : une valeur avec des
    // guillemets et un tag `<script>` ne doit ni s'échapper de l'attribut, ni
    // s'exécuter une fois qu'Alpine et htmx (qui exécute les `<script>` posés
    // par un swap, `allowScriptTags` par défaut) l'ont repris.
    const harness = avecActions([entry()]);
    harness.fichiers.set("/opt/dbox/apps/budget/prod/.env", `SECRET="><script>alert(1)</script>\n`);
    const response = await route("GET", "/api/apps/budget/prod/env", MOI, harness.deps);
    const attribut = /x-data="([^"]*)"/.exec(response.body);
    assert.ok(attribut, `aucun attribut x-data dans : ${response.body}`);
    assert.doesNotMatch(attribut[1]!, /<script/);
    // Si la valeur s'était échappée de l'attribut, hx-target ne serait plus
    // un attribut à part entière — la sortie contiendrait un <script> réel.
    assert.doesNotMatch(response.body, /<script>alert/);
    assert.match(response.body, /hx-target="#sortie-budget-prod"/);
  });

  it("enregistre puis recrée le conteneur, sans reconstruire", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps/budget/prod/env",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ key: "A", value: "9" }),
    );

    assert.equal(response.status, 200);
    assert.match(response.body, /enregistré et appliqué/);
    assert.equal(harness.fichiers.get("/opt/dbox/apps/budget/prod/.env"), "A=9\n");
    // L'image n'a pas changé : recréer suffit, et surtout pas reconstruire.
    assert.deepEqual(harness.calls, [["up", "-d", "--no-build"]]);
  });

  it("n'allume pas une cible à l'arrêt pour appliquer un réglage", async () => {
    // budget doit rester coupée jusqu'à la migration de sa base : enregistrer
    // une variable ne doit pas la remettre en marche.
    const arretee = entry({}, null, "arrêtée");
    const harness = avecActions([arretee]);
    const response = await route(
      "POST",
      "/api/apps/budget/prod/env",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ key: "A", value: "9" }),
    );

    assert.match(response.body, /à l'arrêt/);
    // Le fichier est bien écrit, mais Docker n'est pas appelé.
    assert.equal(harness.fichiers.get("/opt/dbox/apps/budget/prod/.env"), "A=9\n");
    assert.deepEqual(harness.calls, []);
  });

  it("refuse un nom de variable invalide sans rien écrire", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/apps/budget/prod/env",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ key: "2FOIS", value: "x" }),
    );

    assert.match(response.body, /nom de variable valide/);
    assert.equal(harness.fichiers.get("/opt/dbox/apps/budget/prod/.env"), "A=1\nB=deux\n");
    assert.deepEqual(harness.calls, []);
  });

  it("refuse un doublon, que Docker garderait en silence", async () => {
    const harness = avecActions([entry()]);
    const body = new URLSearchParams();
    body.append("key", "A");
    body.append("value", "1");
    body.append("key", "A");
    body.append("value", "2");
    const response = await route(
      "POST",
      "/api/apps/budget/prod/env",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      body.toString(),
    );
    assert.match(response.body, /deux fois/);
  });

  it("n'expose jamais ts.env", async () => {
    // Le chemin est construit côté serveur : aucune requête ne peut le détourner.
    const harness = avecActions([entry()]);
    await route("GET", "/api/apps/budget/prod/env", MOI, harness.deps);
    const response = await route("GET", "/api/apps/budget/prod/ts.env", MOI, harness.deps);
    assert.equal(response.status, 404);
  });
});

describe("réglages d'une cible (dbox.toml)", () => {
  function avecManifeste(toml: string) {
    const harness = avecActions([entry()]);
    harness.fichiers.set("/home/serve/dbox/budget/dbox.toml", toml);
    return harness;
  }

  const DEPLOYED = `name = "budget"\n[targets.prod]\nmode = "deployed"\nport = 8080\n`;

  it("rend les réglages de la cible dans le formulaire", async () => {
    const harness = avecManifeste(DEPLOYED);
    const response = await route("GET", "/api/apps/budget/prod/manifest", MOI, harness.deps);
    assert.match(response.body, /name="port".*value="8080"/);
    assert.match(response.body, /name="health".*value="\/"/);
    // deployed : pas de commande (rien à lancer), mais auto_deploy garde un sens
    // (reconstruire l'image depuis le dépôt).
    assert.doesNotMatch(response.body, /name="command"/);
    assert.match(response.body, /name="autoDeploy"/);
  });

  it("propose la commande et l'auto-déploiement hors du mode deployed", async () => {
    const harness = avecManifeste(
      `name = "budget"\n[targets.dev]\nmode = "devcontainer"\ncommand = "npm run dev"\nport = 5178\n`,
    );
    harness.deps.scan = async () => [entry({ target: "dev", mode: "devcontainer" })];
    const response = await route("GET", "/api/apps/budget/dev/manifest", MOI, harness.deps);
    assert.match(response.body, /name="command" value="npm run dev"/);
    assert.match(response.body, /name="autoDeploy"/);
  });

  it("enregistre un changement, sans jamais redéployer", async () => {
    const harness = avecManifeste(DEPLOYED);
    const response = await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 9090, health: "/" }),
    );

    assert.equal(response.status, 200);
    const written = harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!;
    assert.match(written, /port = 9090/);
    // Comme .env : le fichier change, rien ne redémarre tout seul.
    assert.deepEqual(harness.calls, []);
  });

  it("pose auto_deploy à true seulement si la case est cochée dans le formulaire", async () => {
    const harness = avecManifeste(DEPLOYED);
    await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 8080, health: "/", autoDeploy: "on" }),
    );
    const written = harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!;
    assert.match(written, /auto_deploy = true/);
  });

  it("refuse un port invalide avec le même message que dbox.toml à la main", async () => {
    const harness = avecManifeste(DEPLOYED);
    const response = await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 70000, health: "/" }),
    );
    assert.match(response.body, /port « 70000 » invalide/);
    // Rien n'a été écrit : une entrée refusée ne touche pas au fichier.
    assert.equal(harness.fichiers.get("/home/serve/dbox/budget/dbox.toml"), DEPLOYED);
  });

  it("ne touche pas aux autres cibles du même fichier", async () => {
    const harness = avecManifeste(
      `name = "budget"\n[targets.dev]\nmode = "workspace"\ncommand = "npm run dev"\nport = 5178\n[targets.prod]\nmode = "deployed"\nport = 8080\n`,
    );
    await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 9090, health: "/" }),
    );
    const written = harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!;
    assert.match(written, /\[targets\.dev\]/);
    assert.match(written, /command = "npm run dev"/);
  });
});

describe("page", () => {
  it("affiche l'état, la version et l'URL", () => {
    const html = renderPage(
      [entry({}, { tag: "abc123", previousTag: null, deployedAt: "2026-08-10T06:48:00.000Z" })],
      NOW,
      "moi@exemple.fr",
    );
    assert.match(html, /budget/);
    assert.match(html, /en marche/);
    assert.match(html, /abc123 · 12 min/);
    assert.match(html, /href="https:\/\/budget\.mon-tailnet\.ts\.net"/);
  });

  it("n'affiche aucun bouton en lecture seule", () => {
    const html = renderPage([entry()], NOW, "moi", false);
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /class="ajout"/);
  });

  it("propose d'ajouter une app quand les actions sont là", () => {
    assert.match(renderPage([entry()], NOW, "moi", true), /hx-post="\/api\/apps"/);
  });

  it("propose « Arrêter » sur une cible en marche, « Démarrer » sinon", () => {
    assert.match(renderPage([entry({}, null, "en marche")], NOW, "moi", true), /hx-post="\/api\/apps\/budget\/prod\/stop"/);
    assert.match(renderPage([entry({}, null, "arrêtée")], NOW, "moi", true), /hx-post="\/api\/apps\/budget\/prod\/start"/);
  });

  it("propose un lien vers les réglages quand les actions sont là, pas en lecture seule", () => {
    assert.match(renderPage([entry()], NOW, "moi", true), /href="\/settings"/);
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", false), /href="\/settings"/);
  });

  it("propose un bouton pour éditer le manifeste de la cible", () => {
    assert.match(renderPage([entry()], NOW, "moi", true), /hx-get="\/api\/apps\/budget\/prod\/manifest"/);
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", false), /hx-get="\/api\/apps\/budget\/prod\/manifest"/);
  });

  it("propose de supprimer la cible derrière une confirmation, jamais en lecture seule", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /hx-post="\/api\/apps\/budget\/prod\/remove"/);
    assert.match(html, /hx-confirm="[^"]*budget\/prod[^"]*"/);
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", false), /hx-post="\/api\/apps\/budget\/prod\/remove"/);
  });

  it("le dit quand une cible n'a jamais été déployée", () => {
    assert.match(renderPage([entry({}, null, "jamais démarrée")], NOW, null), /jamais déployée/);
  });

  it("ne se casse pas sur un registre vide", () => {
    assert.match(renderPage([], NOW, null), /Aucune cible déployée/);
  });

  it("le sélecteur de source n'apparaît que si un dossier local est configuré", () => {
    const html = renderPage([entry()], NOW, "moi", true, null, [], "/home/cde/dev");
    assert.match(html, /class="champ champ-source"/);
    assert.match(html, /sous \/home\/cde\/dev/);
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", true, null, [], null), /champ-source/);
  });

  it("échappe la racine des dossiers locaux dans le repère du formulaire", () => {
    const html = renderPage([entry()], NOW, "moi", true, null, [], "/home/cde/<dev>");
    assert.doesNotMatch(html, /<dev>/);
    assert.match(html, /&lt;dev&gt;/);
  });

  it("le sondage automatique ne cible que #cartes, jamais le formulaire d'ajout", () => {
    // Le formulaire « Ajouter » (.ajout) est rendu en dehors de #cartes — le
    // sondage htmx qui rafraîchit la liste des apps ne le retouche donc
    // jamais, plus besoin de garde-fou sur les champs en cours de saisie.
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /<div id="cartes" hx-get="\/api\/apps\/list" hx-trigger="every 15s/);
    const cartesIndex = html.indexOf('<div id="cartes"');
    const ajoutIndex = html.indexOf('class="ajout"');
    assert.ok(ajoutIndex !== -1 && ajoutIndex < cartesIndex, "le formulaire d'ajout précède #cartes");
  });

  it("le sondage suspend le rafraîchissement si un panneau .conf est ouvert dans la liste", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /document\.querySelector\('#cartes \.conf'\)/);
  });

  it("un lecteur seul n'a pas de sondage automatique", () => {
    const html = renderPage([entry()], NOW, "moi", false);
    assert.doesNotMatch(html, /hx-get="\/api\/apps\/list"/);
  });

  it("liste les projets du dossier local en options du menu", () => {
    const html = renderPage(
      [entry()],
      NOW,
      "moi",
      true,
      null,
      [],
      "/home/cde/dev",
      [
        { name: "alpha", command: null },
        { name: "budget", command: "npm run dev" },
      ],
    );
    assert.match(html, /<option value="alpha">alpha<\/option>/);
    assert.match(html, /<option value="budget">budget<\/option>/);
  });

  it("pré-remplit la commande suggérée pour les projets avec un script dev", () => {
    const html = renderPage(
      [entry()],
      NOW,
      "moi",
      true,
      null,
      [],
      "/home/cde/dev",
      [
        { name: "alpha", command: null },
        { name: "budget", command: "npm run dev" },
      ],
    );
    assert.match(html, /commandes: \{&quot;budget&quot;:&quot;npm run dev&quot;\}/);
  });

  it("propose un menu vide sans planter quand aucun projet n'est trouvé", () => {
    const html = renderPage([entry()], NOW, "moi", true, null, [], "/home/cde/dev", []);
    assert.match(html, /<select name="path"/);
  });
});

describe("page des réglages", () => {
  it("n'affiche rien sur l'accès git sans information", () => {
    const html = renderSettingsPage("moi", null, null);
    assert.doesNotMatch(html, /Accès git/);
  });

  it("rappelle la date d'expiration même loin de l'échéance, sans alerte", () => {
    const html = renderSettingsPage("moi", { expiresOn: "2026-11-07", daysLeft: 86 });
    assert.match(html, /Clé Tailscale : expire dans 86 j \(2026-11-07\)/);
    // La feuille de style définit .avis-doux/.avis-fort dans tous les cas ;
    // ce qui compte, c'est qu'aucun élément ne porte cette classe.
    assert.doesNotMatch(html, /class="avis avis-(doux|fort)"/);
  });

  it("bascule sur la bannière colorée une fois dans la fenêtre d'alerte", () => {
    const html = renderSettingsPage("moi", { expiresOn: "2026-08-20", daysLeft: 7 });
    assert.match(html, /class="avis avis-doux"/);
    assert.match(html, /expire dans 7 j/);
  });

  it("propose de générer une clé quand il n'y en a pas", () => {
    const html = renderSettingsPage("moi", null, { exists: false, publicKey: null, canGenerate: true });
    assert.match(html, /hx-post="\/api\/ssh-key"/);
    assert.doesNotMatch(html, /ssh-ed25519/);
  });

  it("affiche la clé publique quand elle existe, jamais un bouton pour en générer une autre", () => {
    const html = renderSettingsPage("moi", null, { exists: true, publicKey: "ssh-ed25519 AAAA dbox", canGenerate: true });
    assert.match(html, /ssh-ed25519 AAAA dbox/);
    assert.doesNotMatch(html, /hx-post="\/api\/ssh-key"/);
  });

  it("un lien ramène à la liste des apps", () => {
    assert.match(renderSettingsPage("moi"), /href="\/"/);
  });
});

describe("route /settings", () => {
  it("rend la clé SSH", async () => {
    const harness = avecActions([entry()]);
    harness.deps.sshKeyStatus = async () => ({ exists: true, publicKey: "ssh-ed25519 AAAA dbox" });
    const response = await route("GET", "/settings", MOI, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /ssh-ed25519 AAAA dbox/);
  });

  it("exige une identité, comme le reste", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/settings", {}, harness.deps);
    assert.equal(response.status, 401);
  });
});

describe("PWA — manifeste et icône", () => {
  it("rend le manifeste de l'app", async () => {
    const response = await route("GET", "/manifest.json", MOI, lecture([]));
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "application/manifest+json; charset=utf-8");
    const manifest = JSON.parse(response.body);
    assert.equal(manifest.name, "DBox");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.display, "standalone");
  });

  it("rend l'icône", async () => {
    const response = await route("GET", "/icon.svg", MOI, lecture([]));
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "image/svg+xml; charset=utf-8");
    assert.match(response.body, /<svg/);
  });

  it("exige une identité, comme le reste", async () => {
    assert.equal((await route("GET", "/manifest.json", {}, lecture([]))).status, 401);
    assert.equal((await route("GET", "/icon.svg", {}, lecture([]))).status, 401);
  });

  it("la page pointe vers les deux", () => {
    assert.match(renderPage([], NOW, "moi"), /<link rel="manifest" href="\/manifest\.json">/);
    assert.match(renderPage([], NOW, "moi"), /<link rel="icon" href="\/icon\.svg"/);
  });
});

describe("htmx et Alpine vendorisés", () => {
  it("sont servis par le daemon lui-même", async () => {
    const htmx = await route("GET", "/htmx.js", MOI, lecture([]));
    assert.equal(htmx.status, 200);
    assert.match(htmx.headers["content-type"]!, /javascript/);
    assert.ok(htmx.body.length > 1000);

    const alpine = await route("GET", "/alpine.js", MOI, lecture([]));
    assert.equal(alpine.status, 200);
    assert.ok(alpine.body.length > 1000);
  });

  it("exigent une identité, comme le reste", async () => {
    assert.equal((await route("GET", "/htmx.js", {}, lecture([]))).status, 401);
    assert.equal((await route("GET", "/alpine.js", {}, lecture([]))).status, 401);
  });

  it("la page les charge en scripts locaux, jamais depuis un CDN", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /<script src="\/htmx\.js">/);
    assert.match(html, /<script src="\/alpine\.js" defer>/);
  });
});

describe("machines connues", () => {
  const UNE_MACHINE = { name: "serve (prod)", url: "https://dbox.mon-tailnet.ts.net" };

  function avecMachines(entries: { name: string; url: string }[], peutEnregistrer = true) {
    const harness = avecActions([entry()]);
    harness.deps.machines = async () => entries;
    if (peutEnregistrer) {
      harness.deps.actions!.saveMachines = async () => {};
    }
    return harness;
  }

  it("404 par défaut : rien de configuré", async () => {
    const response = await route("GET", "/api/machines", MOI, lecture([]));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { entries: [] });
  });

  it("rend la liste configurée", async () => {
    const harness = avecMachines([UNE_MACHINE]);
    const response = await route("GET", "/api/machines", MOI, harness.deps);
    assert.deepEqual(JSON.parse(response.body), { entries: [UNE_MACHINE] });
  });

  it("enregistre une nouvelle liste, avec l'en-tête maison", async () => {
    const harness = avecMachines([]);
    const response = await route(
      "POST",
      "/api/machines",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ nom: "serve (prod)", url: "https://dbox.mon-tailnet.ts.net" }),
    );
    assert.equal(response.status, 200);
    assert.match(response.body, /enregistré/);
  });

  it("refuse une ligne où un seul des deux champs est rempli", async () => {
    const harness = avecMachines([]);
    const response = await route(
      "POST",
      "/api/machines",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ nom: "", url: "https://x" }),
    );
    assert.match(response.body, /nom et URL sont obligatoires/);
  });

  it("ignore en silence une ligne où les deux champs sont vides", async () => {
    const harness = avecMachines([]);
    const response = await route(
      "POST",
      "/api/machines",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ nom: "", url: "" }),
    );
    assert.match(response.body, /enregistré/);
  });

  it("le dit quand cette machine n'a pas de fichier de machines", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "POST",
      "/api/machines",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({}),
    );
    assert.match(response.body, /n'a pas de fichier de machines configuré/);
  });

  it("le sélecteur n'apparaît que s'il y a au moins une autre machine", () => {
    assert.doesNotMatch(renderPage([], NOW, "moi"), /class="machine-select"/);
    assert.match(renderPage([], NOW, "moi", true, null, [UNE_MACHINE]), /class="machine-select"/);
  });

  it("le panneau des réglages liste les machines et propose de les éditer", () => {
    const html = renderSettingsPage("moi", null, null, [UNE_MACHINE], true);
    assert.match(html, /&quot;a&quot;:&quot;serve \(prod\)&quot;/);
    assert.match(html, /&quot;b&quot;:&quot;https:\/\/dbox\.mon-tailnet\.ts\.net&quot;/);
    assert.match(html, /hx-post="\/api\/machines"/);
    assert.doesNotMatch(html, /name="nom"[^>]*disabled/);
    assert.doesNotMatch(html, /name="url"[^>]*disabled/);
  });

  it("sans capacité d'écrire, la liste s'affiche sans pouvoir l'éditer", () => {
    const html = renderSettingsPage("moi", null, null, [UNE_MACHINE], false);
    assert.match(html, /&quot;a&quot;:&quot;serve \(prod\)&quot;/);
    assert.match(html, /name="nom"[^>]*disabled/);
    assert.doesNotMatch(html, /<button type="submit">/);
  });
});

describe("avertissement d'expiration de la clé", () => {
  it("reste silencieux tant qu'il reste plus de deux semaines", () => {
    assert.doesNotMatch(
      renderPage([], NOW, null, true, { expiresOn: "2026-11-07", daysLeft: 86 }),
      /Clé Tailscale/,
    );
  });

  it("avertit dans les deux dernières semaines", () => {
    const html = renderPage([], NOW, null, true, { expiresOn: "2026-08-20", daysLeft: 7 });
    assert.match(html, /expire dans 7 j/);
    assert.match(html, /2026-08-20/);
    // Les apps en place ne sont pas concernées : seules les prochaines le sont.
    assert.match(html, /pas affectées/);
  });

  it("marque le jour même distinctement", () => {
    assert.match(renderPage([], NOW, null, true, { expiresOn: "2026-08-13", daysLeft: 0 }), /expire aujourd'hui/);
  });

  it("passe au ton fort une fois expirée", () => {
    const html = renderPage([], NOW, null, true, { expiresOn: "2026-08-01", daysLeft: -12 });
    assert.match(html, /expirée depuis 12 j/);
    assert.match(html, /avis-fort/);
    assert.match(html, /ne peuvent plus s'inscrire/);
  });

  it("n'affiche rien sans information", () => {
    assert.doesNotMatch(renderPage([], NOW, null, true, null), /Clé Tailscale/);
  });

  it("échappe ce qui vient du disque", () => {
    // Un dbox.json trafiqué ne doit pas pouvoir injecter de balise.
    const html = renderPage([entry({ app: "<script>alert(1)</script>" })], NOW, null, true);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });

  it("tient dans une seule requête : aucune ressource externe", () => {
    const html = renderPage([entry()], NOW, null, true);
    assert.doesNotMatch(html, /src="http|href="http(?!s:\/\/budget)/);
  });

  it("la clé du daemon a sa propre bannière, distincte de celle des apps", () => {
    const html = renderPage(
      [],
      NOW,
      null,
      true,
      null,
      [],
      null,
      [],
      { expiresOn: "2026-08-01", daysLeft: -12 },
    );
    assert.match(html, /Clé Tailscale du daemon/);
    assert.match(html, /expirée depuis 12 j/);
    // La conséquence est plus grave que pour la clé qui sème les apps : sans
    // cette clé-là, c'est le tableau de bord entier qui devient injoignable.
    assert.match(html, /injoignable/);
    assert.doesNotMatch(html, /ne peuvent plus s'inscrire/);
  });

  it("montre les deux bannières ensemble quand les deux clés approchent de l'échéance", () => {
    const html = renderPage(
      [],
      NOW,
      null,
      true,
      { expiresOn: "2026-08-20", daysLeft: 7 },
      [],
      null,
      [],
      { expiresOn: "2026-08-01", daysLeft: -12 },
    );
    assert.match(html, /Clé Tailscale du daemon/);
    assert.match(html, /pas affectées/);
    assert.match(html, /injoignable/);
  });

  it("la clé du daemon apparaît aussi sur /settings, dans les deux tons", () => {
    const loin = renderSettingsPage("moi", null, null, [], false, { expiresOn: "2026-11-07", daysLeft: 86 });
    assert.match(loin, /Clé Tailscale du daemon : expire dans 86 j/);

    const proche = renderSettingsPage("moi", null, null, [], false, { expiresOn: "2026-08-01", daysLeft: -12 });
    assert.match(proche, /avis-fort/);
    assert.match(proche, /injoignable/);
  });

  it("route : la bannière de la clé du daemon vient de deps.adminAuthkeyNotice, indépendamment de authkeyNotice", async () => {
    const harness = avecActions([]);
    harness.deps.adminAuthkeyNotice = async () => ({ expiresOn: "2026-08-01", daysLeft: -12 });

    const page = await route("GET", "/", MOI, harness.deps);
    assert.match(page.body, /Clé Tailscale du daemon/);

    const settings = await route("GET", "/settings", MOI, harness.deps);
    assert.match(settings.body, /Clé Tailscale du daemon/);
  });

  it("n'affiche rien pour les nœuds abandonnés sans rapport — même règle que l'absence de clé", () => {
    assert.doesNotMatch(renderSettingsPage("moi"), /Nœuds Tailscale/);
  });

  it("affiche un état neutre quand le rapport ne signale rien", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null,
      { checkedAt: "2026-08-16T12:00:00.000Z", tag: "tag:dbox", stale: [] },
      null,
      Date.parse("2026-08-16T13:00:00.000Z"),
    );
    assert.match(html, /Nœuds Tailscale : aucun abandonné/);
    assert.doesNotMatch(html, /class="avis avis-doux"/);
  });

  it("liste les nœuds abandonnés, jamais de bouton pour les supprimer", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null,
      {
        checkedAt: "2026-08-16T12:00:00.000Z",
        tag: "tag:custom",
        stale: [{ hostname: "vieille-app", id: "3", lastSeen: "2026-07-01T00:00:00Z" }],
      },
      null,
      Date.parse("2026-08-16T13:00:00.000Z"),
    );
    assert.match(html, /1 nœud\(s\) Tailscale/);
    // Le tag affiché vient du rapport, jamais un « tag:dbox » codé en dur —
    // sinon un --ts-tag différent afficherait un message trompeur.
    assert.match(html, /tag:custom/);
    assert.match(html, /vieille-app/);
    assert.match(html, /class="avis avis-doux"/);
    assert.doesNotMatch(html, /<button/);
  });

  it("échappe le contenu du rapport, comme tout ce qui vient du disque", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null,
      {
        checkedAt: "2026-08-16T12:00:00.000Z",
        tag: "tag:dbox",
        stale: [{ hostname: "<script>alert(1)</script>", id: "3", lastSeen: "2026-07-01T00:00:00Z" }],
      },
      null,
      Date.parse("2026-08-16T13:00:00.000Z"),
    );
    assert.doesNotMatch(html, /<script>alert/);
  });

  it("route : le rapport vient de deps.orphansReport, jamais d'un appel API du daemon lui-même", async () => {
    const harness = avecActions([]);
    harness.deps.orphansReport = async () => ({
      checkedAt: "2026-08-16T12:00:00.000Z",
      tag: "tag:dbox",
      stale: [{ hostname: "vieille-app", id: "3", lastSeen: "2026-07-01T00:00:00Z" }],
    });

    const settings = await route("GET", "/settings", MOI, harness.deps);
    assert.match(settings.body, /vieille-app/);

    const page = await route("GET", "/", MOI, harness.deps);
    assert.doesNotMatch(page.body, /vieille-app/); // uniquement sur /settings
  });

  it("n'affiche rien pour le tag sans rapport", () => {
    assert.doesNotMatch(renderSettingsPage("moi"), /Tag Tailscale/);
  });

  it("affiche un état neutre quand le tag est présent dans tagOwners", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null, null,
      { checkedAt: "2026-08-16T12:00:00.000Z", tag: "tag:dbox", present: true, suggestedLine: null },
      Date.parse("2026-08-16T13:00:00.000Z"),
    );
    assert.match(html, /Tag Tailscale.*tag:dbox.*déclaré dans tagOwners/);
    assert.doesNotMatch(html, /class="avis avis-doux"/);
  });

  it("affiche la ligne à coller quand le tag est absent, jamais de bouton pour l'ajouter soi-même", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null, null,
      {
        checkedAt: "2026-08-16T12:00:00.000Z",
        tag: "tag:dbox",
        present: false,
        suggestedLine: '"tag:dbox": ["autogroup:admin"],',
      },
      Date.parse("2026-08-16T13:00:00.000Z"),
    );
    assert.match(html, /class="avis avis-doux"/);
    assert.match(html, /échouerait à son inscription/);
    assert.match(html, /&quot;tag:dbox&quot;: \[&quot;autogroup:admin&quot;\],/);
    assert.doesNotMatch(html, /<button/);
  });

  it("échappe la ligne suggérée, comme tout ce qui vient du disque", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null, null,
      {
        checkedAt: "2026-08-16T12:00:00.000Z",
        tag: "tag:dbox",
        present: false,
        suggestedLine: '"tag:dbox": ["<script>alert(1)</script>"],',
      },
      Date.parse("2026-08-16T13:00:00.000Z"),
    );
    assert.doesNotMatch(html, /<script>alert/);
  });

  it("route : le rapport de tag vient de deps.tagReport, jamais du daemon lui-même", async () => {
    const harness = avecActions([]);
    harness.deps.tagReport = async () => ({
      checkedAt: "2026-08-16T12:00:00.000Z",
      tag: "tag:dbox",
      present: false,
      suggestedLine: '"tag:dbox": ["autogroup:admin"],',
    });

    const settings = await route("GET", "/settings", MOI, harness.deps);
    assert.match(settings.body, /autogroup:admin/);

    const page = await route("GET", "/", MOI, harness.deps);
    assert.doesNotMatch(page.body, /autogroup:admin/); // uniquement sur /settings
  });
});
