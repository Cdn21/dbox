/**
 * Le daemon.
 *
 * L'aiguillage est une fonction pure : une méthode, un chemin, des en-têtes
 * donnent un statut, des en-têtes et un corps. Le serveur HTTP n'est qu'une glu
 * autour, ce qui rend tout testable sans ouvrir de socket.
 *
 * Deux protections encadrent les actions :
 *  - **l'identité** vient des en-têtes que `tailscale serve` ajoute aux requêtes
 *    proxifiées ; sans elle, rien n'est servi. Le seul chemin d'accès est donc
 *    le sidecar, et par lui l'ACL du tailnet ;
 *  - **un en-tête maison** est exigé sur toute écriture. Un formulaire d'un site
 *    tiers ne peut pas en poser, et un `fetch` qui en pose déclenche un contrôle
 *    préalable auquel on ne répond jamais. Sans ça, l'identité étant injectée
 *    par le proxy, n'importe quelle page ouverte dans ton navigateur pourrait
 *    déclencher un déploiement. htmx pose cet en-tête lui-même sur chaque
 *    requête (voir le script embarqué dans `page.ts`) — le serveur continue de
 *    l'exiger explicitement, jamais de confiance aveugle dans le client.
 *
 * Les routes que le tableau de bord déclenche via htmx rendent des fragments
 * HTML, pas du JSON — htmx les pose directement dans la page. `GET /api/apps`
 * reste la seule route pensée comme une API de lecture générale.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Compose, RunResult } from "./docker.ts";
import { track, type Jobs } from "./jobs.ts";
import {
  applyEnv,
  logsOf,
  readEnv,
  readManifestTarget,
  startTarget,
  stopTarget,
  writeEnv,
  writeManifestTarget,
  type NewTargetChoice,
} from "./actions.ts";
import type { NewTargetMode } from "./init.ts";
import { validateEntries, type EnvEntry } from "./env.ts";
import {
  actionResult,
  cleAppFragment,
  envPanelFragment,
  escape,
  ICON_SVG,
  jobFragment,
  logsFragment,
  MANIFEST_JSON,
  manifestPanelFragment,
  renderList,
  renderPage,
  renderSettingsPage,
  sshKeyPanel,
} from "./page.ts";
import { ACTION_HEADER, IDENTITY_HEADERS } from "./protocol.ts";
import { HTMX_JS, ALPINE_JS } from "./vendor.ts";
import type { AuthkeyNotice } from "./authkey.ts";
import type { OrphansReport } from "./orphans-report.ts";
import type { TagReport } from "./tag-report.ts";
import type { Entry } from "./registry.ts";
import type { MachineEntry } from "./machines.ts";
import type { UpResult } from "./up.ts";

export { ACTION_HEADER, IDENTITY_HEADERS };

export interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Actions {
  compose: Compose;
  jobs: Jobs;
  redeploy: (entry: Entry, log: (line: string) => void) => Promise<UpResult>;
  remove: (entry: Entry) => Promise<RunResult>;
  /** Absente quand la machine n'est pas configurée pour cloner des dépôts. */
  add?: (url: string, name: string | null, log: (line: string) => void, choice?: NewTargetChoice) => Promise<UpResult>;
  /** Absente si aucune racine de dossiers locaux n'est configurée. */
  addLocal?: (path: string, log: (line: string) => void, choice?: NewTargetChoice) => Promise<UpResult>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  /** Absente si aucun emplacement de clé n'est configuré sur cette machine. */
  generateSshKey?: () => Promise<{ created: boolean; publicKey: string }>;
  /** Absente pour la même raison — une clé par app suppose une clé machine. */
  generateAppSshKey?: (appName: string) => Promise<{ created: boolean; publicKey: string }>;
  /** Absente si cette machine n'a pas de fichier de machines configuré. */
  saveMachines?: (entries: MachineEntry[]) => Promise<void>;
}

export interface Deps {
  scan: () => Promise<Entry[]>;
  now: () => number;
  /** Absentes en lecture seule : toute écriture répond alors 405. */
  actions?: Actions;
  /** `null` si aucune date n'est renseignée — pas d'avertissement, pas d'erreur. */
  authkeyNotice?: () => Promise<AuthkeyNotice | null>;
  /** La clé du daemon lui-même (`tag:dbox-admin`, `deploy/ts.env`), distincte
   * de celle qui sème les nouvelles apps — sa propre échéance, jamais
   * couverte par `authkeyNotice`. */
  adminAuthkeyNotice?: () => Promise<AuthkeyNotice | null>;
  /** Rapport des nœuds Tailscale abandonnés, écrit par `dbox rotate-authkey`
   * dans son propre conteneur — le daemon ne fait que le lire, jamais
   * d'appel API lui-même. `null` : rien à afficher, comme les autres avis. */
  orphansReport?: () => Promise<OrphansReport | null>;
  /** Présence de `--ts-tag` dans `tagOwners` de la policy Tailscale — même
   * principe que `orphansReport` : écrit ailleurs, lu tel quel ici. */
  tagReport?: () => Promise<TagReport | null>;
  /** La clé publique n'est pas un secret : lisible même sans capacité d'écrire. */
  sshKeyStatus?: () => Promise<{ exists: boolean; publicKey: string | null }>;
  /** Idem, pour la clé dédiée d'une app en particulier. */
  appSshKeyStatus?: (appName: string) => Promise<{ exists: boolean; publicKey: string | null }>;
  /** Absente si cette machine n'a pas de fichier de machines configuré — le
   * sélecteur reste alors absent de la page, pas cassé. */
  machines?: () => Promise<MachineEntry[]>;
  /** Racine des dossiers locaux déployables sans clonage — affichée en repère
   * dans le formulaire. `undefined` : « dossier local » reste absent. */
  workspacesRoot?: string;
  /** Sous-dossiers de `workspacesRoot`, pour choisir dans une liste plutôt
   * que taper un nom. Absente ou vide : la liste déroulante reste vide.
   * `command` : script `dev` détecté dans le `package.json` du dossier, s'il
   * y en a un — pré-remplit le champ Commande au lieu de le laisser deviner
   * depuis un simple placeholder. */
  listWorkspaces?: () => Promise<{ name: string; command: string | null }[]>;
}

type Headers = Record<string, string | string[] | undefined>;

export function viewerOf(headers: Headers): string | null {
  for (const name of IDENTITY_HEADERS) {
    const value = headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== "") return single;
  }
  return null;
}

/** htmx pose cet en-tête sur chaque requête qu'il émet — sert à distinguer un
 * clic dans le tableau de bord d'un appel direct à l'API (curl, un script). */
function isHtmx(headers: Headers): boolean {
  const value = headers["hx-request"];
  return (Array.isArray(value) ? value[0] : value) === "true";
}

export async function route(
  method: string,
  path: string,
  headers: Headers,
  deps: Deps,
  query: URLSearchParams = new URLSearchParams(),
  body = "",
): Promise<Response> {
  // Interrogé en local par le contrôle de santé du conteneur : ni identité, ni
  // registre, aucune dépendance.
  if (path === "/health") return text(200, "ok\n");

  const viewer = viewerOf(headers);
  if (viewer === null) {
    return text(401, "identité Tailscale absente — passer par le sidecar\n");
  }

  const segments = path.split("/").filter((segment) => segment !== "");

  if (method === "GET" || method === "HEAD") {
    if (segments.length === 0) {
      const notice = deps.authkeyNotice === undefined ? null : await deps.authkeyNotice();
      const adminNotice = deps.adminAuthkeyNotice === undefined ? null : await deps.adminAuthkeyNotice();
      const machines = deps.machines === undefined ? [] : await deps.machines();
      const canAddLocal = deps.actions?.addLocal !== undefined;
      const projects = canAddLocal && deps.listWorkspaces !== undefined ? await deps.listWorkspaces() : [];
      return html(
        renderPage(
          await deps.scan(),
          deps.now(),
          viewer,
          deps.actions !== undefined,
          notice,
          machines,
          canAddLocal ? (deps.workspacesRoot ?? null) : null,
          projects,
          adminNotice,
        ),
      );
    }
    if (path === "/settings") {
      const notice = deps.authkeyNotice === undefined ? null : await deps.authkeyNotice();
      const adminNotice = deps.adminAuthkeyNotice === undefined ? null : await deps.adminAuthkeyNotice();
      const sshKey =
        deps.sshKeyStatus === undefined
          ? null
          : { ...(await deps.sshKeyStatus()), canGenerate: deps.actions?.generateSshKey !== undefined };
      const machines = deps.machines === undefined ? [] : await deps.machines();
      const orphans = deps.orphansReport === undefined ? null : await deps.orphansReport();
      const tagReport = deps.tagReport === undefined ? null : await deps.tagReport();
      return html(
        renderSettingsPage(
          viewer,
          notice,
          sshKey,
          machines,
          deps.actions?.saveMachines !== undefined,
          adminNotice,
          orphans,
          tagReport,
          deps.now(),
        ),
      );
    }
    if (path === "/api/machines") {
      return json({ entries: deps.machines === undefined ? [] : await deps.machines() });
    }
    if (path === "/manifest.json") {
      return { status: 200, headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" }, body: MANIFEST_JSON };
    }
    if (path === "/icon.svg") {
      return { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" }, body: ICON_SVG };
    }
    if (path === "/htmx.js") {
      return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }, body: HTMX_JS };
    }
    if (path === "/alpine.js") {
      return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }, body: ALPINE_JS };
    }
    if (path === "/api/ssh-key") {
      if (deps.sshKeyStatus === undefined) return text(404, "clé SSH non configurée sur cette machine\n");
      return json(await deps.sshKeyStatus());
    }
    if (path === "/api/apps/list") {
      return html(renderList(await deps.scan(), deps.now(), deps.actions !== undefined));
    }
    if (path === "/api/apps") {
      return json(
        (await deps.scan()).map((entry) => ({
          ...entry.descriptor,
          status: entry.status,
          state: entry.state,
        })),
      );
    }
    if (segments[0] === "api" && segments[1] === "jobs" && segments.length === 3) {
      const job = deps.actions?.jobs.get(segments[2]!);
      if (job === undefined || job === null) return text(404, "tâche inconnue\n");
      return isHtmx(headers) ? html(jobFragment(job)) : json(job);
    }
    // Par app, pas par cible : un seul dépôt cloné sert toutes les cibles
    // d'une même app, la clé qui l'ouvre n'a donc rien à voir avec l'une d'elles.
    if (segments[0] === "api" && segments[1] === "apps" && segments.length === 4 && segments[3] === "ssh-key") {
      if (deps.appSshKeyStatus === undefined) return text(404, "clé SSH par app non configurée sur cette machine\n");
      return json(await deps.appSshKeyStatus(segments[2]!));
    }
    if (segments[0] === "api" && segments[1] === "apps" && segments.length === 5) {
      if (deps.actions === undefined) return notAllowed();
      const entry = await find(deps, segments[2]!, segments[3]!);
      if (entry === null) return text(404, "cible inconnue\n");

      if (segments[4] === "logs") {
        const lines = Math.min(Math.max(Number(query.get("lines") ?? 200) || 200, 1), 2000);
        const output = await logsOf(entry, deps.actions.compose, lines);
        return html(logsFragment(output));
      }
      if (segments[4] === "env") {
        const entries = await readEnv(entry, deps.actions.readFile);
        return html(envPanelFragment(entry.descriptor.app, entry.descriptor.target, entries));
      }
      if (segments[4] === "manifest") {
        try {
          const target = await readManifestTarget(entry, deps.actions.readFile);
          const cle =
            deps.appSshKeyStatus === undefined ? null : await deps.appSshKeyStatus(entry.descriptor.app);
          return html(manifestPanelFragment(entry.descriptor.app, entry.descriptor.target, target, cle));
        } catch (error) {
          return html(actionResult(false, (error as Error).message, false));
        }
      }
    }
    return text(404, "inconnu\n");
  }

  if (method !== "POST") return notAllowed();
  if (deps.actions === undefined) return notAllowed();
  if (headers[ACTION_HEADER] === undefined) {
    return text(400, `en-tête ${ACTION_HEADER} manquant\n`);
  }

  if (path === "/api/apps") return await addApp(body, deps.actions);

  if (path === "/api/machines") return await saveMachinesRoute(body, deps.actions);

  if (path === "/api/ssh-key") {
    const generate = deps.actions.generateSshKey;
    if (generate === undefined) return text(404, "clé SSH non configurée sur cette machine\n");
    let erreur: string | null = null;
    try {
      await generate();
    } catch (error) {
      erreur = (error as Error).message;
    }
    const status =
      deps.sshKeyStatus === undefined ? null : { ...(await deps.sshKeyStatus()), canGenerate: true };
    const panneau = sshKeyPanel(status);
    return html(erreur === null ? panneau : `${panneau}<p class="cle-info">${escape(erreur)}</p>`);
  }

  if (segments[0] === "api" && segments[1] === "apps" && segments.length === 4 && segments[3] === "ssh-key") {
    const generate = deps.actions.generateAppSshKey;
    if (generate === undefined) return text(404, "clé SSH par app non configurée sur cette machine\n");
    const app = segments[2]!;
    try {
      await generate(app);
    } catch (error) {
      const cle = { exists: false, publicKey: null };
      return html(`${cleAppFragment(app, cle)}<p class="cle-info">${escape((error as Error).message)}</p>`);
    }
    const cle = deps.appSshKeyStatus === undefined ? null : await deps.appSshKeyStatus(app);
    return html(cleAppFragment(app, cle));
  }

  if (segments[0] === "api" && segments[1] === "apps" && segments.length === 5) {
    const entry = await find(deps, segments[2]!, segments[3]!);
    if (entry === null) return text(404, "cible inconnue\n");
    if (segments[4] === "env") return await saveEnvRoute(entry, body, deps.actions);
    if (segments[4] === "manifest") return await saveManifestRoute(entry, body, deps.actions);
    return await act(entry, segments[4]!, deps.actions);
  }

  return text(404, "inconnu\n");
}

async function act(entry: Entry, action: string, actions: Actions): Promise<Response> {
  const label = `${entry.descriptor.app}/${entry.descriptor.target}`;

  if (action === "start" || action === "stop") {
    const result = await (action === "start"
      ? startTarget(entry, actions.compose)
      : stopTarget(entry, actions.compose));
    const ok = result.code === 0;
    return html(actionResult(ok, ok ? null : result.stderr || result.stdout, true));
  }

  if (action === "remove") {
    // Un redéploiement en cours écrit encore dans ce dossier — le supprimer
    // sous ses pieds laisserait un état à moitié détruit, pas juste une
    // suppression ratée.
    if (actions.jobs.runningFor(label) !== null) {
      return html(actionResult(false, "un redéploiement est en cours — réessaie une fois terminé", false));
    }
    const result = await actions.remove(entry);
    const ok = result.code === 0;
    return html(actionResult(ok, ok ? "supprimée" : result.stderr || result.stdout, true));
  }

  if (action !== "up") return text(404, `action « ${action} » inconnue\n`);

  // Un redéploiement dure des minutes : on rend la main tout de suite et on
  // suit la tâche par sondage htmx. Deux en parallèle sur la même cible se
  // marcheraient dessus — qu'ils viennent du bouton, ou du sondage automatique.
  const result = track(actions.jobs, label, (log) => actions.redeploy(entry, log));
  return html(jobFragment(result.started ? result.job : result.running));
}

const NEW_TARGET_MODES: NewTargetMode[] = ["deployed", "workspace", "devcontainer"];

type ChoiceResult = { ok: true; choice: NewTargetChoice | undefined } | { ok: false; detail: string };

/**
 * Le choix de mode du formulaire, quand il en dit quelque chose — `deployed`
 * (ou l'absence de mode) n'en fait pas un : lui seul se devine encore depuis
 * le Dockerfile après coup, `addApp`/`addLocalApp` savent déjà l'ignorer.
 * Un message distinct par cause, comme le reste du projet : « les messages
 * d'erreur sont le produit », pas un « invalide » générique.
 */
function parseChoice(form: URLSearchParams): ChoiceResult {
  const mode = form.get("mode");
  if (mode === null || mode === "deployed") return { ok: true, choice: undefined };
  if (!NEW_TARGET_MODES.includes(mode as NewTargetMode)) {
    return { ok: false, detail: `mode inconnu : ${mode}` };
  }

  const port = Number(form.get("port"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, detail: "port invalide" };
  }

  const command = form.get("command")?.trim();
  if (command === undefined || command === "") {
    return { ok: false, detail: "commande manquante pour ce mode" };
  }

  return { ok: true, choice: { mode: mode as NewTargetMode, port, command } };
}

async function addApp(body: string, actions: Actions): Promise<Response> {
  const form = new URLSearchParams(body);
  const url = (form.get("url") ?? "").trim();
  const path = (form.get("path") ?? "").trim();
  const name = form.get("name")?.trim() || null;

  const parsed = parseChoice(form);
  if (!parsed.ok) return html(actionResult(false, parsed.detail, false));
  const choice = parsed.choice;

  // Un chemin l'emporte sur une URL : le formulaire n'envoie jamais les deux
  // à la fois, mais un dossier déjà là n'a rien à cloner.
  if (path !== "") {
    if (actions.addLocal === undefined) {
      return html(actionResult(false, "cette machine n'est pas configurée pour ajouter un dossier local", false));
    }
    const label = `ajout ${path}`;
    const addLocal = actions.addLocal;
    const result = track(actions.jobs, label, (log) => addLocal(path, log, choice));
    return html(jobFragment(result.started ? result.job : result.running));
  }

  if (actions.add === undefined) {
    return html(actionResult(false, "cette machine n'est pas configurée pour cloner des dépôts", false));
  }
  if (url === "") return html(actionResult(false, "url ou chemin manquant", false));

  const label = `ajout ${url}`;
  const add = actions.add;
  const result = track(actions.jobs, label, (log) => add(url, name, log, choice));
  return html(jobFragment(result.started ? result.job : result.running));
}

async function saveManifestRoute(entry: Entry, body: string, actions: Actions): Promise<Response> {
  let current;
  try {
    current = await readManifestTarget(entry, actions.readFile);
  } catch (error) {
    return html(actionResult(false, (error as Error).message, false));
  }

  const form = new URLSearchParams(body);
  const changes: Record<string, unknown> = {
    port: Number(form.get("port")),
    health: form.get("health")?.trim() || "/",
  };
  if (current.mode !== "deployed") changes.command = form.get("command") ?? "";
  if (current.mode !== "workspace") changes.autoDeploy = form.has("autoDeploy");

  try {
    await writeManifestTarget(entry, changes, actions.readFile, actions.writeFile);
    return html(actionResult(true, "enregistré — s'applique au prochain déploiement", false));
  } catch (error) {
    // Une erreur de validation (ManifestError) est une faute de saisie, pas une
    // panne : même message clair que dbox.toml écrit à la main.
    return html(actionResult(false, (error as Error).message, false));
  }
}

async function saveMachinesRoute(body: string, actions: Actions): Promise<Response> {
  if (actions.saveMachines === undefined) {
    return html(actionResult(false, "cette machine n'a pas de fichier de machines configuré", false));
  }

  const form = new URLSearchParams(body);
  const noms = form.getAll("nom");
  const urls = form.getAll("url");
  const paires = noms.map((name, i) => ({ name: name.trim(), url: (urls[i] ?? "").trim() }));

  // Une ligne où un seul des deux champs est rempli est une vraie faute de
  // saisie, à signaler — une ligne où aucun des deux ne l'est n'est qu'un
  // « Ajouter » jamais utilisé, à ignorer en silence plutôt qu'à refuser.
  const partielle = paires.find((p) => (p.name === "") !== (p.url === ""));
  if (partielle !== undefined) {
    return html(actionResult(false, "nom et URL sont obligatoires", false));
  }
  const entries: MachineEntry[] = paires.filter((p) => p.name !== "" && p.url !== "");

  await actions.saveMachines(entries);
  return html(actionResult(true, "enregistré", false));
}

async function saveEnvRoute(entry: Entry, body: string, actions: Actions): Promise<Response> {
  const form = new URLSearchParams(body);
  const keys = form.getAll("key");
  const values = form.getAll("value");
  const entries: EnvEntry[] = keys
    .map((key, i) => ({ key, value: values[i] ?? "" }))
    .filter((e) => e.key.trim() !== "");

  const invalid = validateEntries(entries);
  if (invalid !== null) return html(actionResult(false, invalid, false));

  await writeEnv(entry, entries, actions.writeFile);

  // Recréer le conteneur suffit : l'image n'a pas changé, seul le fichier lu
  // au démarrage a changé. Et rien n'est recréé si la cible est à l'arrêt.
  const applied = await applyEnv(entry, actions.compose);
  if (applied === null) {
    return html(actionResult(true, "cible à l'arrêt : pris en compte au démarrage", false));
  }
  return html(actionResult(applied.code === 0, applied.code === 0 ? "enregistré et appliqué" : applied.stderr || applied.stdout, false));
}

async function find(deps: Deps, app: string, target: string): Promise<Entry | null> {
  const entries = await deps.scan();
  return (
    entries.find((entry) => entry.descriptor.app === app && entry.descriptor.target === target) ?? null
  );
}

function text(status: number, body: string): Response {
  return { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body };
}

function html(body: string): Response {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body };
}

function json(value: unknown, status = 200): Response {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(value, null, 2),
  };
}

function notAllowed(): Response {
  return {
    status: 405,
    headers: { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" },
    body: "méthode non autorisée\n",
  };
}

/** Borné : rien de légitime n'approche cette taille pour un fichier de réglages. */
const MAX_BODY = 256 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  if (request.method !== "POST") return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        // Sans ça, la connexion reste ouverte et continue d'accumuler dans
        // `body` après le rejet — un corps illimité pour une réponse déjà
        // décidée.
        request.destroy();
        reject(new Error("corps trop volumineux"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export function createServer(deps: Deps) {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://dbox");
    readBody(request)
      .then((body) =>
        route(request.method ?? "GET", url.pathname, request.headers, deps, url.searchParams, body),
      )
      .then((result) => {
        response.writeHead(result.status, result.headers);
        response.end(request.method === "HEAD" ? undefined : result.body);
      })
      .catch((error: Error) => {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(`erreur interne : ${error.message}\n`);
      });
  });
}
