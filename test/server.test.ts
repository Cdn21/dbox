import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../src/docker.ts";
import { Jobs } from "../src/jobs.ts";
import { renderPage, renderSettingsPage } from "../src/ui/index.ts";
import { ACTION_HEADER } from "../src/protocol.ts";
import type { Entry } from "../src/registry.ts";
import { createServer, route, viewerOf, type Actions, type Deps } from "../src/server.ts";
import type { AddressInfo } from "node:net";
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
      publicDomain: null,
      services: [],
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

  it("sans liste d'autorisation, toute identité du tailnet passe", async () => {
    const r = await route("GET", "/api/apps/list", { "tailscale-user-login": "quelconque@ailleurs" }, lecture([]));
    assert.equal(r.status, 200);
  });

  it("avec une liste, une identité hors liste reçoit 403, même en lecture", async () => {
    const deps: Deps = { ...lecture([entry()]), allowedUsers: ["proprio@github"] };
    const intrus = await route("GET", "/api/apps/budget/prod/env", { "tailscale-user-login": "intrus@ailleurs" }, deps);
    assert.equal(intrus.status, 403);
    // /env ne renvoie donc aucune valeur à un non-autorisé.
    assert.doesNotMatch(intrus.body, /value=/);
  });

  it("avec une liste, le propriétaire passe (casse ignorée)", async () => {
    const deps: Deps = { ...lecture([entry()]), allowedUsers: ["proprio@github"] };
    const r = await route("GET", "/api/apps/list", { "tailscale-user-login": "Proprio@GitHub" }, deps);
    assert.equal(r.status, 200);
  });

  it("une liste vide ne restreint rien", async () => {
    const deps: Deps = { ...lecture([]), allowedUsers: [] };
    assert.equal((await route("GET", "/api/apps/list", { "tailscale-user-login": "x@y" }, deps)).status, 200);
  });

  it("la liste ne bloque jamais /health", async () => {
    const deps: Deps = { ...lecture([]), allowedUsers: ["proprio@github"] };
    assert.equal((await route("GET", "/health", {}, deps)).status, 200);
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

describe("supprimer une cible depuis le panneau Manifeste", () => {
  function avecManifeste() {
    const harness = avecActions([entry()]);
    harness.fichiers.set(
      "/home/serve/dbox/budget/dbox.toml",
      'name = "budget"\n\n[targets.prod]\nmode = "deployed"\nport = 8080\n',
    );
    return harness;
  }

  it("propose la suppression derrière une confirmation, à côté de la configuration qu'elle détruit", async () => {
    const harness = avecManifeste();
    const response = await route("GET", "/api/apps/budget/prod/manifest", MOI, harness.deps);
    assert.match(response.body, /hx-post="\/api\/apps\/budget\/prod\/remove"/);
    assert.match(response.body, /hx-confirm="[^"]*budget\/prod[^"]*"/);
  });

  it("pose le bouton hors du formulaire, sinon le navigateur enregistrerait en même temps", async () => {
    const harness = avecManifeste();
    const response = await route("GET", "/api/apps/budget/prod/manifest", MOI, harness.deps);
    const fin = response.body.indexOf("</form>");
    assert.ok(fin !== -1, "le panneau doit contenir un formulaire");
    assert.ok(
      response.body.indexOf("/remove") > fin,
      "« Supprimer » doit venir après la fermeture du formulaire",
    );
  });

  it("reste hors de portée d'un lecteur seul : le panneau ne s'ouvre pas", async () => {
    const html = renderPage([entry()], NOW, "moi", false);
    assert.doesNotMatch(html, /data-action="manifest"/);
    assert.doesNotMatch(html, /\/remove/);
  });
});

describe("agir en un geste", () => {
  it("redémarre par la commande qu'on taperait, sans passer par arrêter puis démarrer", async () => {
    const harness = avecActions([entry()]);
    const response = await route("POST", "/api/apps/budget/prod/restart", AGIR, harness.deps);
    assert.equal(response.status, 200);
    assert.deepEqual(harness.calls, [["restart"]]);
  });

  it("ne propose de redémarrer que ce qui tourne", () => {
    assert.match(renderPage([entry({}, null, "en marche")], NOW, "moi", true), /hx-post="[^"]*\/restart"/);
    assert.doesNotMatch(renderPage([entry({}, null, "arrêtée")], NOW, "moi", true), /hx-post="[^"]*\/restart"/);
  });

  it("offre d'appliquer tout de suite ce qui vient d'être enregistré", async () => {
    const harness = avecActions([entry()]);
    harness.fichiers.set(
      "/home/serve/dbox/budget/dbox.toml",
      'name = "budget"\n\n[targets.prod]\nmode = "deployed"\nport = 8080\n',
    );
    const response = await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      undefined,
      form({ port: 9090, health: "/" }),
    );
    assert.match(response.body, /prochain déploiement/);
    assert.match(response.body, /Redéployer maintenant/);
    assert.match(response.body, /hx-post="\/api\/apps\/budget\/prod\/up"/);
  });

  it("n'offre pas ce bouton quand l'enregistrement a échoué", async () => {
    const harness = avecActions([entry()]);
    harness.fichiers.set(
      "/home/serve/dbox/budget/dbox.toml",
      'name = "budget"\n\n[targets.prod]\nmode = "deployed"\nport = 8080\n',
    );
    const response = await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      undefined,
      form({ port: 0, health: "/" }),
    );
    assert.doesNotMatch(response.body, /Redéployer maintenant/);
  });

  it("nomme le conteneur fautif quand l'état est partiel", () => {
    const partielle: Entry = {
      ...entry({}, null, "partielle"),
      containers: [
        { name: "dbox-budget-prod-app-1", state: "running" },
        { name: "dbox-budget-prod-db-1", state: "exited" },
        { name: "dbox-budget-prod-tailscale-1", state: "running" },
      ],
    };
    const html = renderPage([partielle], NOW, "moi", true);
    assert.match(html, /class="souci">db : exited<\/div>/);
    // Le préfixe du projet et le suffixe de réplique n'apprennent rien de plus
    // que ce que la carte porte déjà.
    assert.doesNotMatch(html, /dbox-budget-prod-db-1/);
  });

  it("ne dit rien sur une cible saine, même avec plusieurs conteneurs", () => {
    const saine: Entry = {
      ...entry({}, null, "en marche"),
      containers: [
        { name: "dbox-budget-prod-app-1", state: "running" },
        { name: "dbox-budget-prod-db-1", state: "running" },
      ],
    };
    assert.doesNotMatch(renderPage([saine], NOW, "moi", true), /class="souci"/);
  });

  it("laisse entier un nom de conteneur posé à la main", () => {
    const partielle: Entry = {
      ...entry({}, null, "redémarre"),
      containers: [{ name: "ma-base-perso", state: "restarting" }],
    };
    assert.match(renderPage([partielle], NOW, "moi", true), /ma-base-perso : restarting/);
  });
});

describe("panneau des fichiers générés", () => {
  /** Le dossier d'une cible tel qu'il est vraiment : les fichiers montrables,
   * et les deux qu'on ne doit jamais voir passer dans une réponse HTTP. */
  function avecDossier(state: Entry["state"] = null) {
    const harness = avecActions([entry({}, state)]);
    const d = "/opt/dbox/apps/budget/prod";
    harness.fichiers.set(`${d}/docker-compose.yml`, "services:\n  app:\n    image: budget:abc\n");
    harness.fichiers.set(`${d}/serve.json`, `{ "TCP": {} }\n`);
    harness.fichiers.set(`${d}/dbox.json`, `{ "app": "budget" }\n`);
    harness.fichiers.set(`${d}/ts.env`, "TS_AUTHKEY=tskey-auth-SECRET\n");
    return harness;
  }

  it("rend les trois fichiers que DBox a produits", async () => {
    const harness = avecDossier();
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /<summary>docker-compose\.yml<\/summary>/);
    assert.match(response.body, /<summary>serve\.json<\/summary>/);
    assert.match(response.body, /<summary>dbox\.json<\/summary>/);
    assert.match(response.body, /image: budget:abc/);
  });

  it("ne montre jamais ts.env, ni la clé qu'il porte", async () => {
    const harness = avecDossier();
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.doesNotMatch(response.body, /ts\.env/);
    assert.doesNotMatch(response.body, /tskey-auth/);
  });

  it("ne montre pas .env non plus : il a son panneau, avec les valeurs masquées", async () => {
    const harness = avecDossier();
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    // `.env` existe dans le dossier de test (posé par `avecActions`).
    assert.doesNotMatch(response.body, /B=deux/);
  });

  it("échappe le contenu d'un fichier avant de l'insérer dans la page", async () => {
    const harness = avecDossier();
    harness.fichiers.set("/opt/dbox/apps/budget/prod/dbox.json", `{ "app": "<script>alert(1)</script>" }`);
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.doesNotMatch(response.body, /<script>alert/);
    assert.match(response.body, /&lt;script&gt;/);
  });

  it("dit d'où vient le code, et vers quoi un retour arrière ramènerait", async () => {
    const harness = avecDossier({
      tag: "abc123",
      previousTag: "def456",
      deployedAt: "2026-08-10T06:00:00.000Z",
    });
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.match(response.body, /<code>\/home\/serve\/dbox\/budget<\/code>/);
    assert.match(response.body, /version précédente<\/span> <code>def456<\/code>/);
  });

  it("tait la version précédente quand il n'y en a pas", async () => {
    const harness = avecDossier({ tag: "abc123", previousTag: null, deployedAt: "2026-08-10T06:00:00.000Z" });
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.doesNotMatch(response.body, /version précédente/);
  });

  it("s'ouvre sans planter sur une cible jamais déployée", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.equal(response.status, 200);
    assert.match(response.body, /jamais été déployée/);
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

  it("refuse de démarrer, arrêter ou redémarrer une cible en cours de redéploiement", async () => {
    const harness = avecActions([entry()]);
    await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);
    const avant = harness.calls.length;

    for (const action of ["start", "stop", "restart"]) {
      const response = await route("POST", `/api/apps/budget/prod/${action}`, AGIR, harness.deps);
      assert.equal(response.status, 200);
      assert.match(response.body, /redéploiement est en cours/, action);
    }
    // Aucune commande docker compose n'est partie.
    assert.equal(harness.calls.length, avant);
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

  it("transmet l'image et le Dockerfile choisis pour un devcontainer", async () => {
    const harness = avecActions([entry()]);
    await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({
        url: "x",
        mode: "devcontainer",
        port: 8000,
        command: "uvicorn app:app --host 0.0.0.0",
        image: "python:3.13-slim",
        dockerfile: "Dockerfile.dev",
      }),
    );
    assert.deepEqual(harness.addCalls, [
      [
        "x",
        null,
        {
          mode: "devcontainer",
          port: 8000,
          command: "uvicorn app:app --host 0.0.0.0",
          image: "python:3.13-slim",
          dockerfile: "Dockerfile.dev",
        },
      ],
    ]);
  });

  it("laisse image et dockerfile absents quand les champs sont vides", async () => {
    const harness = avecActions([entry()]);
    await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "devcontainer", port: 8000, command: "x", image: "", dockerfile: "" }),
    );
    assert.deepEqual(harness.addCalls, [["x", null, { mode: "devcontainer", port: 8000, command: "x" }]]);
  });

  it("ignore image et dockerfile hors du mode devcontainer", async () => {
    // Le manifeste les refuserait en workspace : les laisser passer écrirait
    // un dbox.toml qu'on ne pourrait plus relire.
    const harness = avecActions([entry()]);
    await route(
      "POST",
      "/api/apps",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ url: "x", mode: "workspace", port: 5178, command: "x", image: "python:3.13-slim" }),
    );
    assert.deepEqual(harness.addCalls, [["x", null, { mode: "workspace", port: 5178, command: "x" }]]);
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

  it("refuse d'enregistrer le .env d'une cible en cours de redéploiement", async () => {
    const harness = avecActions([entry()]);
    await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);
    const avant = harness.calls.length;

    const response = await route(
      "POST",
      "/api/apps/budget/prod/env",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ key: "A", value: "9" }),
    );

    assert.match(response.body, /redéploiement est en cours/);
    // Ni fichier écrit, ni `up -d` glissé au milieu du redéploiement.
    assert.equal(harness.fichiers.get("/opt/dbox/apps/budget/prod/.env"), "A=1\nB=deux\n");
    assert.equal(harness.calls.length, avant);
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

  it("transmet les services compagnons que le formulaire porte désormais", async () => {
    // Ils survivaient jadis parce que le formulaire les ignorait ; ils
    // survivent maintenant parce qu'il les renvoie. La garantie a changé de
    // nature, pas de résultat.
    const harness = avecManifeste(
      `name = "budget"\n[targets.prod]\nmode = "deployed"\nport = 8080\n` +
        `[targets.prod.services.db]\nimage = "postgres:16-alpine"\ndata = "/var/lib/postgresql/data"\n`,
    );
    const corps = new URLSearchParams({ port: "9090", health: "/", data: "/app/data" });
    corps.append("serviceNom", "db");
    corps.append("serviceImage", "postgres:16-alpine");
    corps.append("serviceData", "/var/lib/postgresql/data");

    await route("POST", "/api/apps/budget/prod/manifest", AGIR, harness.deps, new URLSearchParams(), corps.toString());

    const written = harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!;
    assert.match(written, /port = 9090/);
    assert.match(written, /data = "\/app\/data"/);
    assert.match(written, /\[targets\.prod\.services\.db\]/);
    assert.match(written, /image = "postgres:16-alpine"/);
  });

  it("retire un compagnon quand sa ligne disparaît du formulaire", async () => {
    const harness = avecManifeste(
      `name = "budget"\n[targets.prod]\nmode = "deployed"\nport = 8080\n` +
        `[targets.prod.services.db]\nimage = "postgres:16-alpine"\n`,
    );
    await route(
      "POST", "/api/apps/budget/prod/manifest", AGIR, harness.deps,
      new URLSearchParams(), form({ port: 8080, health: "/" }),
    );
    assert.doesNotMatch(harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!, /services/);
  });

  it("refuse une ligne de service à moitié remplie", async () => {
    const harness = avecManifeste(DEPLOYED);
    const corps = new URLSearchParams({ port: "8080", health: "/" });
    corps.append("serviceNom", "db");
    corps.append("serviceImage", "");
    corps.append("serviceData", "");

    const response = await route("POST", "/api/apps/budget/prod/manifest", AGIR, harness.deps, new URLSearchParams(), corps.toString());
    assert.match(response.body, /au moins un nom et une image/);
    assert.equal(harness.fichiers.get("/home/serve/dbox/budget/dbox.toml"), DEPLOYED);
  });

  it("refuse deux compagnons de même nom, que Docker ne garderait qu'une fois", async () => {
    const harness = avecManifeste(DEPLOYED);
    const corps = new URLSearchParams({ port: "8080", health: "/" });
    for (const _ of [0, 1]) {
      corps.append("serviceNom", "db");
      corps.append("serviceImage", "postgres:16-alpine");
      corps.append("serviceData", "");
    }
    const response = await route("POST", "/api/apps/budget/prod/manifest", AGIR, harness.deps, new URLSearchParams(), corps.toString());
    assert.match(response.body, /deux services nommés/);
  });

  it("renvoie le message du manifeste sur une image invalide, sans valider deux fois", async () => {
    const harness = avecManifeste(DEPLOYED);
    const corps = new URLSearchParams({ port: "8080", health: "/" });
    corps.append("serviceNom", "MaBase");
    corps.append("serviceImage", "postgres:16");
    corps.append("serviceData", "");

    const response = await route("POST", "/api/apps/budget/prod/manifest", AGIR, harness.deps, new URLSearchParams(), corps.toString());
    assert.match(response.body, /n'est pas un nom de service valide/);
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

  it("propose un champ de domaine public, en texte libre", async () => {
    const harness = avecManifeste(DEPLOYED);
    const response = await route("GET", "/api/apps/budget/prod/manifest", MOI, harness.deps);
    assert.match(response.body, /name="publicDomain" value=""/);
  });

  it("n'affiche pas le champ en mode workspace : rien à router sans conteneur", async () => {
    const harness = avecManifeste(
      `name = "budget"\n[targets.dev]\nmode = "workspace"\ncommand = "npm run dev"\nport = 5178\n`,
    );
    harness.deps.scan = async () => [entry({ target: "dev", mode: "workspace" })];
    const response = await route("GET", "/api/apps/budget/dev/manifest", MOI, harness.deps);
    assert.doesNotMatch(response.body, /publicDomain/);
  });

  it("enregistre le domaine saisi", async () => {
    const harness = avecManifeste(DEPLOYED);
    await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 8080, health: "/", publicDomain: "budget.exemple.fr" }),
    );
    assert.match(harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!, /public_domain = "budget\.exemple\.fr"/);
  });

  it("repasse la cible en privé quand le champ est vidé", async () => {
    const harness = avecManifeste(
      `name = "budget"\n[targets.prod]\nmode = "deployed"\nport = 8080\npublic_domain = "budget.exemple.fr"\n`,
    );
    await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 8080, health: "/", publicDomain: "" }),
    );
    assert.doesNotMatch(harness.fichiers.get("/home/serve/dbox/budget/dbox.toml")!, /public_domain/);
  });

  it("refuse un domaine mal formé avec le même message qu'un dbox.toml à la main", async () => {
    const harness = avecManifeste(DEPLOYED);
    const response = await route(
      "POST",
      "/api/apps/budget/prod/manifest",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ port: 8080, health: "/", publicDomain: "https://budget.exemple.fr" }),
    );
    assert.match(response.body, /« public_domain » doit être un nom de domaine/);
    assert.equal(harness.fichiers.get("/home/serve/dbox/budget/dbox.toml"), DEPLOYED);
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

  it("signale qu'une cible est exposée sur internet, et donne les deux URL", () => {
    // C'est l'information la plus lourde de conséquences qu'une carte porte :
    // sans elle, une app publique ressemble trait pour trait à une app privée.
    const html = renderPage([entry({ publicDomain: "budget.exemple.fr" })], NOW, "moi", true);
    assert.match(html, /class="etat publique"/);
    assert.match(html, /https:\/\/budget\.exemple\.fr/);
    // l'URL privée reste là : l'exposition est additive
    assert.match(html, /https:\/\/budget\.mon-tailnet\.ts\.net/);
  });

  it("ne dit rien de public pour une cible privée", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.doesNotMatch(html, /class="etat publique"/);
  });

  it("liste les services compagnons : une cible avec base ne ressemble pas à une sans", () => {
    const html = renderPage([entry({ services: ["db", "cache"] })], NOW, "moi", true);
    assert.match(html, /\+ db, cache/);
  });

  it("signale le redéploiement automatique", () => {
    assert.match(renderPage([entry({ autoDeploy: true })], NOW, "moi", true), /· auto/);
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", true), /· auto/);
  });

  it("échappe ce qui vient du disque dans les nouveaux champs", () => {
    const html = renderPage(
      [entry({ services: ["<script>x</script>"] })],
      NOW, "moi", true,
    );
    assert.doesNotMatch(html, /<script>x/);
  });

  it("propose un bouton pour éditer le manifeste de la cible", () => {
    // Des bascules Alpine, pas des `hx-get` : refermer ne doit rien demander
    // au serveur.
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /data-action="fichiers" data-url="\/api\/apps\/budget\/prod\/fichiers"/);
    assert.match(html, /data-action="manifest" data-url="\/api\/apps\/budget\/prod\/manifest"/);
    assert.match(html, /@click="bascule\(\$el\.dataset\.action, \$el\.dataset\.url\)"/);
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", false), /data-action="manifest"/);
  });

  it("ne laisse jamais « Supprimer » sur la surface toujours visible", () => {
    // Déplacé dans le panneau Manifeste — dix cartes, c'était dix boutons
    // irréversibles à un clic. Le test du panneau garde sa présence.
    assert.doesNotMatch(renderPage([entry()], NOW, "moi", true), /hx-post="\/api\/apps\/budget\/prod\/remove"/);
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

  it("le sondage se suspend pour tout ce qu'il détruirait sans pouvoir le reconstruire", () => {
    // Le sondage remplace toutes les cartes : sans ces gardes, une édition en
    // cours, un panneau qu'on lit, un journal suivi ou un redéploiement dont on
    // regarde la progression disparaissaient au bout de 15 s.
    const html = renderPage([entry()], NOW, "moi", true);
    for (const garde of ["#cartes .conf", "#cartes .fichiers", "#cartes .journal", "#cartes .job"]) {
      assert.ok(html.includes(garde), `garde manquante : ${garde}`);
    }
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

describe("retrouver une cible dans la liste", () => {
  /** Plusieurs apps, dont une à deux cibles — c'est ce que le groupement
   * change — et assez nombreuses pour que le champ de filtre apparaisse. */
  const dix = [
    entry({ app: "atef", target: "prod" }),
    entry({ app: "budget", target: "dev", hostname: "budget-dev" }),
    entry({ app: "budget", target: "prod", publicDomain: "budget.appvc.fr" }),
    entry({ app: "git", target: "prod" }),
    entry({ app: "temoin", target: "prod" }),
    entry({ app: "vault", target: "prod" }),
  ];

  it("pose le champ de filtre en dehors de #cartes, pour qu'il survive au sondage", () => {
    const html = renderPage(dix, NOW, "moi", true);
    const avant = html.indexOf(`x-data="{ q: '' }"`);
    const cartes = html.indexOf(`id="cartes"`);
    assert.ok(avant !== -1 && avant < cartes, "la portée Alpine doit englober #cartes, pas y être");
    assert.match(html, /x-model(\.\w+)?="q"/);
  });

  it("cherche sur le nom, la cible et le domaine public — jamais dans l'expression Alpine", () => {
    const html = renderPage(dix, NOW, "moi", true);
    assert.match(html, /data-cherche="budget prod budget\.appvc\.fr en marche public"/);
    assert.match(html, /data-cherche="budget dev  en marche"/);
    // L'expression est du JavaScript : le texte cherché passe par un attribut,
    // sinon une apostrophe dans un nom y ouvrirait une injection.
    assert.match(html, /x-show="!q \|\| \$el\.dataset\.cherche\.includes\(q\.toLowerCase\(\)\)"/);
    assert.doesNotMatch(html, /x-show="[^"]*budget\.appvc\.fr/);
  });

  it("rend le bloc d'app filtrable lui aussi, sinon le filtre laisse des trous", () => {
    const html = renderPage(dix, NOW, "moi", true);
    // Le bloc porte la concaténation de ses cibles : il reste visible dès
    // qu'une seule correspond, et disparaît de la grille sinon.
    assert.match(
      html,
      /<ul class="app app-multiple" data-cherche="budget dev  en marche budget prod budget\.appvc\.fr en marche public" x-show=/,
    );
    assert.match(html, /<ul class="app" data-cherche="atef prod  en marche" x-show=/);
  });

  it("groupe les cibles d'une même app dans un seul bloc", () => {
    const html = renderPage(dix, NOW, "moi", true);
    assert.equal((html.match(/<ul class="app/g) ?? []).length, 5); // 6 cibles, 5 apps
    // Les deux cibles de budget dans le même <ul>, atef seul dans le sien.
    const bloc = html.slice(html.indexOf(`data-cherche="budget dev`));
    const fin = bloc.indexOf("</ul>");
    assert.equal((bloc.slice(0, fin).match(/<li id="carte-/g) ?? []).length, 2);
  });

  it("résume l'état de la machine avant les cartes", () => {
    const html = renderPage(
      [
        entry({ app: "a" }, null, "en marche"),
        entry({ app: "b", publicDomain: "b.exemple.fr" }, null, "arrêtée"),
        entry({ app: "c" }, null, "partielle"),
      ],
      NOW,
      "moi",
      true,
    );
    assert.match(html, /3 cibles<\/button>/);
    assert.match(html, /1 en marche<\/button>/);
    assert.match(html, /<strong>1 en souffrance<\/strong><\/button>/);
    assert.match(html, /1 publique<\/button>/);
  });

  it("tait ce qui vaut zéro — pas de « 0 publique » ni de « 0 en souffrance »", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /1 cible<\/button>/);
    assert.match(html, /1 en marche<\/button>/);
    assert.doesNotMatch(html, /souffrance/);
    assert.doesNotMatch(html, /0 publique/);
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

  it("n'affiche rien sur le mode public sans réglage machine", () => {
    assert.doesNotMatch(renderSettingsPage("moi"), /Mode public/);
  });

  it("affiche le réseau et le resolver quand le mode public est configuré", () => {
    const html = renderSettingsPage("moi", null, null, [], false, null, null, null, NOW, {
      network: "traefik-net",
      certResolver: "letsencrypt",
    });
    assert.match(html, /Mode public/);
    assert.match(html, /traefik-net/);
    assert.match(html, /letsencrypt/);
  });

  it("n'affiche pas de version quand l'image n'en porte pas", () => {
    assert.doesNotMatch(renderSettingsPage("moi"), /Version du daemon/);
  });

  it("affiche la version gravée dans l'image", () => {
    const html = renderSettingsPage("moi", null, null, [], false, null, null, null, NOW, null, "1e4e15071cb0");
    assert.match(html, /Version du daemon/);
    assert.match(html, /1e4e15071cb0/);
    assert.doesNotMatch(html, /arbre modifié/);
  });

  it("signale une image construite depuis un arbre modifié", () => {
    const html = renderSettingsPage("moi", null, null, [], false, null, null, null, NOW, null, "1e4e15071cb0-sale");
    assert.match(html, /arbre modifié/);
  });

  it("échappe la version, comme tout ce qui vient de l'extérieur", () => {
    const html = renderSettingsPage("moi", null, null, [], false, null, null, null, NOW, null, "<script>x</script>");
    assert.doesNotMatch(html, /<script>x/);
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

  it("le panneau du mode public vient de deps.traefik", async () => {
    const harness = avecActions([entry()]);
    harness.deps.traefik = { network: "traefik-net", certResolver: "letsencrypt" };
    const response = await route("GET", "/settings", MOI, harness.deps);
    assert.match(response.body, /Mode public/);
    assert.match(response.body, /traefik-net/);
  });

  it("la version vient de deps.version", async () => {
    const harness = avecActions([entry()]);
    harness.deps.version = "abc123def456";
    const response = await route("GET", "/settings", MOI, harness.deps);
    assert.match(response.body, /Version du daemon/);
    assert.match(response.body, /abc123def456/);
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
    const enregistrees: { name: string; url: string }[][] = [];
    harness.deps.machines = async () => entries;
    if (peutEnregistrer) {
      harness.deps.actions!.saveMachines = async (e) => {
        enregistrees.push(e);
      };
    }
    return { ...harness, enregistrees };
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

  it("refuse une URL qui n'est pas http(s), sans rien enregistrer", async () => {
    const harness = avecMachines([]);
    const response = await route(
      "POST",
      "/api/machines",
      AGIR,
      harness.deps,
      new URLSearchParams(),
      form({ nom: "piège", url: "javascript:alert(1)" }),
    );
    assert.match(response.body, /n'est pas une adresse http\(s\)/);
    assert.equal(harness.enregistrees.length, 0);
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

describe("état de la machine sur /settings", () => {
  const NOW_S = Date.parse("2026-08-16T13:00:00.000Z");
  const VU = "2026-08-16T12:00:00.000Z";

  it("rassemble les constats sous un titre, au lieu de les laisser flotter", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null,
      { checkedAt: VU, tag: "tag:dbox", stale: [] },
      { checkedAt: VU, tag: "tag:dbox", present: true, suggestedLine: null },
      NOW_S,
      { network: "traefik-net", certResolver: "letsencrypt" },
      "abc1234",
    );
    const bloc = html.indexOf(`class="etat-machine"`);
    assert.ok(bloc !== -1, "le bloc doit exister dès qu'il y a un constat");
    assert.match(html, /<h2>État de la machine<\/h2>/);
    // Les quatre constats sont dedans, pas éparpillés avant.
    const dedans = html.slice(bloc);
    for (const attendu of [/aucun abandonné/, /déclaré dans tagOwners/, /Mode public/, /Version du daemon/]) {
      assert.match(dedans, attendu);
    }
  });

  it("garde les avis au-dessus du bloc : ils appellent un geste, pas une lecture", () => {
    const html = renderSettingsPage(
      "moi", null, null, [], false, null,
      {
        checkedAt: VU,
        tag: "tag:dbox",
        stale: [{ hostname: "vieille-app", id: "3", lastSeen: "2026-07-01T00:00:00Z" }],
      },
      null,
      NOW_S,
      null,
      "abc1234",
    );
    const avis = html.indexOf(`class="avis avis-doux"`);
    const bloc = html.indexOf(`class="etat-machine"`);
    assert.ok(avis !== -1 && bloc !== -1);
    assert.ok(avis < bloc, "un avis doit précéder le bloc de constats");
  });

  it("ne pose pas de cadre vide quand il n'y a rien à constater", () => {
    const html = renderSettingsPage("moi");
    // `etat-machine` tout court apparaîtrait dans la feuille de style ; c'est
    // l'élément qu'on cherche, pas la règle CSS qui le décrit.
    assert.doesNotMatch(html, /class="etat-machine"/);
    assert.doesNotMatch(html, /État de la machine/);
  });
});

describe("une page qui se referme", () => {
  it("rend la liste utilisable sans Alpine, en lecture seule", () => {
    // Le piège : `x-cloak` vaut `display:none !important` tant qu'Alpine ne
    // l'a pas retiré — et une page sans actions ne charge ni htmx ni Alpine.
    // Poser le filtre sans cette garde masquait la liste entière.
    // `[x-cloak]` figure aussi dans la feuille de style : c'est l'attribut
    // posé sur un élément qu'on traque, pas la règle CSS qui le décrit.
    const html = renderPage([entry()], NOW, null, false);
    assert.doesNotMatch(html, / x-cloak>/);
    assert.doesNotMatch(html, /x-show=/);
    assert.doesNotMatch(html, /x-data=/);
    assert.doesNotMatch(html, /class="filtre"/);
    assert.match(html, /budget/);
  });

  it("garde le filtre complet dès que les actions sont là", () => {
    const beaucoup = ["a", "b", "c", "d", "e"].map((app) => entry({ app }));
    const html = renderPage(beaucoup, NOW, "moi", true);
    assert.match(html, /class="filtre"/);
    assert.match(html, / x-cloak>/);
  });

  it("n'affiche pas le champ de filtre sous le seuil : la liste tient déjà dans l'écran", () => {
    const quatre = ["a", "b", "c", "d"].map((app) => entry({ app }));
    assert.doesNotMatch(renderPage(quatre, NOW, "moi", true), /class="filtre"/);
    assert.match(renderPage([...quatre, entry({ app: "e" })], NOW, "moi", true), /class="filtre"/);
    // Le résumé, lui, reste toujours là — il ne coûte qu'une ligne.
    assert.match(renderPage(quatre, NOW, "moi", true), /class="resume"/);
  });

  it("marque le panneau ouvert sur son bouton, pour savoir où recliquer", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /:class="\{ actif: panneau === \$el\.dataset\.action \}"/);
    assert.match(html, /x-data="dbCarte\('budget-prod'\)"/);
  });

  it("replie le formulaire d'ajout quand il y a déjà des cibles à regarder", () => {
    assert.match(renderPage([entry()], NOW, "moi", true), /x-data="\{ ouvert: false \}"/);
    assert.match(renderPage([entry()], NOW, "moi", true), /Ajouter une app/);
  });

  it("l'ouvre d'office sur une machine encore vide : c'est le seul geste possible", () => {
    assert.match(renderPage([], NOW, "moi", true), /x-data="\{ ouvert: true \}"/);
  });

  it("les compteurs du résumé posent le filtre, et sont inertes sans Alpine", () => {
    const actif = renderPage([entry({ publicDomain: "b.exemple.fr" })], NOW, "moi", true);
    assert.match(actif, /@click="q = q === 'public' \? '' : 'public'"/);
    // Le premier compteur remet tout à zéro plutôt que de filtrer sur rien.
    assert.match(actif, /@click="q = q === '' \? '' : ''"/);

    const lecture = renderPage([entry({ publicDomain: "b.exemple.fr" })], NOW, null, false);
    assert.doesNotMatch(lecture, /@click/);
    assert.match(lecture, /class="compteur-inerte"/);
  });

  it("« souci » atteint les deux états en souffrance, que rien d'autre ne réunit", () => {
    const html = renderPage(
      [entry({ app: "a" }, null, "partielle"), entry({ app: "b" }, null, "redémarre")],
      NOW,
      "moi",
      true,
    );
    assert.equal((html.match(/data-cherche="[^"]*souci"/g) ?? []).length, 4); // 2 cartes + 2 blocs
    assert.match(html, /@click="q = q === 'souci' \? '' : 'souci'"/);
  });
});

describe("journal suivi en direct", () => {
  it("se repose lui-même, sur la même cible et le même nombre de lignes", async () => {
    const harness = avecActions([entry()]);
    const response = await route(
      "GET",
      "/api/apps/budget/prod/logs",
      MOI,
      harness.deps,
      new URLSearchParams("lines=50"),
    );
    // Le nombre de lignes ne vit plus dans l'URL : il voyage avec le menu,
    // inclus à chaque passage — et la valeur en cours y figure, même hors liste.
    assert.match(response.body, /hx-get="\/api\/apps\/budget\/prod\/logs"/);
    assert.match(response.body, /hx-include="#journal-budget-prod \.journal-reglages"/);
    assert.match(response.body, /<option value="50" selected>50 lignes<\/option>/);
    assert.match(response.body, /hx-trigger="every 3s \[/);
    assert.match(response.body, /hx-swap="outerHTML"/);
    assert.match(response.body, /<pre>journal ligne 1\n?<\/pre>/);
  });

  it("ne sonde pas un onglet en arrière-plan, ni un journal mis en pause", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.match(response.body, /!document\.hidden/);
    assert.match(response.body, /journal-budget-prod'\)\.classList\.contains\('pause'\)/);
  });

  it("recolle le défilement au bas : les lignes neuves arrivent en dernier", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.match(response.body, /#journal-budget-prod pre'\);[^<]*scrollTop = p\.scrollHeight/);
    // Le script vient après le <pre>, sinon il ne trouverait rien à recoller.
    assert.ok(response.body.indexOf("scrollHeight") > response.body.indexOf("</pre>"));
  });

  it("se referme en vidant le conteneur, jamais en retirant le bloc qui se remplace", async () => {
    // Le bloc est remplacé toutes les 3 s : celui qu'on a sous le doigt peut
    // déjà être détaché au moment du clic, et le retirer ne ferait rien.
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.match(response.body, /getElementById\('sortie-budget-prod'\)\.innerHTML = ''/);
    assert.doesNotMatch(response.body, /closest\('\.journal'\)\.remove/);
  });

  it("agrandit les cibles tactiles : 25 px de haut se rataient au doigt", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /@media \(pointer: coarse\)/);
    assert.match(html, /min-height:2\.75rem/);
  });

  it("échappe toujours le contenu, malgré la nouvelle enveloppe", async () => {
    const harness = avecActions([entry()], 0);
    harness.deps.actions!.compose = async () => ({ code: 0, stdout: "<img onerror=alert(1)>", stderr: "" });
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.doesNotMatch(response.body, /<img onerror/);
    assert.match(response.body, /&lt;img onerror/);
  });
});

describe("ce que le sondage de la liste ne doit pas détruire", () => {
  it("le journal porte la classe qui le protège du remplacement des cartes", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/logs", MOI, harness.deps);
    assert.match(response.body, /class="journal"/);
  });

  it("le panneau des fichiers aussi", async () => {
    const harness = avecActions([entry()]);
    const response = await route("GET", "/api/apps/budget/prod/fichiers", MOI, harness.deps);
    assert.match(response.body, /class="fichiers"/);
  });

  it("le suivi d'un redéploiement en cours aussi — sinon on perd la progression", async () => {
    const harness = avecActions([entry()]);
    const lance = await route("POST", "/api/apps/budget/prod/up", AGIR, harness.deps);
    assert.match(lance.body, /class="job"/);
    assert.match(lance.body, /hx-trigger="every 1500ms"/);
  });

  it("mais pas un simple message de résultat : le figer suspendrait tout pour rien", async () => {
    const harness = avecActions([entry({}, null, "arrêtée")]);
    const response = await route("POST", "/api/apps/budget/prod/start", AGIR, harness.deps);
    for (const garde of ["journal", "fichiers", `class="job"`, `class="conf"`]) {
      assert.ok(!response.body.includes(garde), `un résultat ne doit pas porter ${garde}`);
    }
  });
});

describe("tenir dans un téléphone", () => {
  it("laisse la colonne rétrécir sous sa borne basse, sinon 130 px sortent de l'écran", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    // Sans le min(), auto-fit impose 34rem (544 px) même sur un écran de 430.
    assert.match(html, /minmax\(min\(34rem, 100%\), 1fr\)/);
    assert.doesNotMatch(html, /minmax\(34rem, 1fr\)/);
  });

  it("garde le lien entier même quand l'écran n'en montre qu'une partie", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    // Le schéma est enveloppé, pas retiré : la CSS le masque sur écran étroit,
    // mais href et texte copié restent une URL valide.
    assert.match(html, /href="https:\/\/budget\.mon-tailnet\.ts\.net"/);
    assert.match(html, /<span class="schema">https:\/\/<\/span>budget\.mon-tailnet\.ts\.net/);
    assert.match(html, /a\.url \.schema \{ display:none; \}/);
  });

  it("rend la boîte de #cartes transparente sans le sortir du sondage", () => {
    const html = renderPage([entry()], NOW, "moi", true);
    assert.match(html, /\.liste-apps > #cartes \{ display:contents; \}/);
    // Il reste bien la cible du sondage : c'est tout l'intérêt.
    assert.match(html, /<div id="cartes" hx-get="\/api\/apps\/list"/);
  });
});

describe("un nom piégé n'atteint jamais une expression JavaScript", () => {
  /**
   * Rend la page avec ce nom d'app, puis exécute chaque expression Alpine `@click`
   * pour de vrai, avec des espions : aucune ne doit appeler autre chose que
   * `bascule`. C'est la preuve qu'on cherchait à la revue — exécuter, pas lire.
   */
  function executeLesClics(app: string): string[] {
    const html = renderPage([entry({ app, hostname: "x" })], NOW, "moi", true);
    const appels: string[] = [];
    const espion = new Proxy({}, { get: (_cible, nom) => (..._a: unknown[]) => { appels.push(String(nom)); return 0; } });
    for (const [, expression] of html.matchAll(/@click="([^"]*)"/g)) {
      const js = expression!.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
      // `$el.dataset` vaut ce que le navigateur lirait dans les attributs data-*.
      const $el = { dataset: { action: "a", url: "u" }, closest: () => ({ classList: { toggle() {} }, remove() {} }) };
      try {
        new Function("bascule", "$el", "q", "document", "console", "alert", "fetch", js)(
          (...a: unknown[]) => appels.push(`bascule(${a.length})`), $el, "", espion, espion,
          () => appels.push("alert"), () => appels.push("fetch"),
        );
      } catch { /* une expression qui ne se compile pas n'exécute rien non plus */ }
    }
    return appels;
  }

  for (const piege of [
    "x')-alert(1)-('",
    "x');alert(1);('",
    "x'+alert(1)+'",
    "x\\u0027)-alert(1)-(\\u0027",
  ]) {
    it(`n'exécute rien de plus que bascule avec le nom ${JSON.stringify(piege)}`, () => {
      const appels = executeLesClics(piege);
      assert.ok(appels.length > 0, "les boutons doivent quand même fonctionner");
      assert.ok(appels.every((a) => a.startsWith("bascule(")), `appels inattendus : ${appels.join(", ")}`);
    });
  }
});

describe("en-têtes de sécurité, sur toute réponse", () => {
  // Posés par createServer, pas par route : un test de bout en bout, sur un
  // vrai serveur. Garde contre le clickjacking (un site tiers encadre la page).
  async function entetes(chemin: string, en: Record<string, string>): Promise<Headers> {
    const serveur = createServer({ scan: async () => [], now: () => NOW });
    await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r));
    try {
      const port = (serveur.address() as AddressInfo).port;
      const reponse = await fetch(`http://127.0.0.1:${port}${chemin}`, { headers: en });
      await reponse.text();
      return reponse.headers;
    } finally {
      await new Promise<void>((r) => serveur.close(() => r()));
    }
  }

  for (const [nom, chemin, en] of [
    ["la page", "/", MOI],
    ["/health sans identité", "/health", {}],
    ["une réponse 401", "/", {}],
  ] as const) {
    it(`interdit le cadrage et le reniflage de type sur ${nom}`, async () => {
      const h = await entetes(chemin, en);
      assert.equal(h.get("x-frame-options"), "DENY");
      assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      assert.match(h.get("content-security-policy") ?? "", /object-src 'none'/);
      assert.equal(h.get("x-content-type-options"), "nosniff");
      assert.equal(h.get("strict-transport-security"), "max-age=31536000");
      assert.equal(h.get("referrer-policy"), "no-referrer");
    });
  }
});
