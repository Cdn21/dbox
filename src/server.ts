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
import type { VersionInfo } from "./versions.ts";
import type { CertNotice } from "./cert.ts";
import type { Constat } from "./doctor.ts";
import {
  apercuManifeste,
  applyEnv,
  logsOf,
  resolveWorkspacePath,
  readEnv,
  restartTarget,
  readGeneratedFiles,
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
  apercuFragment,
  diagnosticFragment,
  cleAppFragment,
  envPanelFragment,
  escape,
  fichiersPanelFragment,
  ICON_SVG,
  jobFragment,
  logsFragment,
  redeployerMaintenant,
  MANIFEST_JSON,
  manifestPanelFragment,
  cleCible,
  renderList,
  renderPage,
  type Extras,
  type JobView,
  renderSettingsPage,
  sshKeyPanel,
  type HeadscaleStatus,
  type TraefikStatus,
} from "./ui/index.ts";
import { ACTION_HEADER, IDENTITY_HEADERS } from "./protocol.ts";
import { HTMX_JS, ALPINE_JS } from "./vendor.ts";
import type { AuthkeyNotice } from "./authkey.ts";
import type { OrphansReport } from "./orphans-report.ts";
import type { TagReport } from "./tag-report.ts";
import type { Entry } from "./registry.ts";
import { estUrlWeb, type MachineEntry } from "./machines.ts";
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
  /** Les réglages du mode public reçus au démarrage — `undefined` : non
   * configuré sur cette machine, le panneau reste absent de /settings. */
  traefik?: TraefikStatus;
  /** Réglages headscale reçus au démarrage — `undefined` : backend headscale
   * non configuré ici, le panneau reste absent de /settings. */
  headscale?: () => Promise<HeadscaleStatus | null>;
  /** Échéance de la clé préauth Headscale (`<fichier>.expires`) — même
   * mécanisme que la clé Tailscale. `undefined` : rien à signaler. */
  headscaleAuthkeyNotice?: () => Promise<AuthkeyNotice | null>;
  /** Échéance du certificat wildcard headscale (lue dans le certificat, pas un
   * `.expires`) — `undefined` : backend non headscale, ou rien à signaler. */
  headscaleCertNotice?: () => Promise<CertNotice | null>;
  /** Version gravée dans l'image à la construction (`$DBOX_VERSION`) —
   * `undefined` : rien à afficher, comme les autres renseignements. */
  version?: string;
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
  /** Lien vers le commit déployé et retard de la source (`versions.ts`) —
   * absent, les cartes montrent le SHA nu, comme avant. */
  versionInfo?: (source: string, tag: string) => Promise<VersionInfo>;
  /** Le diagnostic de `dbox doctor`, vu depuis le daemon — lecture seule, et
   * sans jamais le token d'API (voir doctor.ts). Absent : pas de panneau. */
  diagnostic?: () => Promise<Constat[]>;
  /** Les identités Tailscale autorisées (login en minuscules). Absente ou vide :
   * toute identité du tailnet passe, comme avant — l'ACL du tailnet reste la
   * seule frontière. Posée : les autres identités reçoivent 403, même en
   * lecture. C'est elle qui ferme l'accès aux secrets (`/env`) et au reste à
   * tout appareil du tailnet qui n'est pas le propriétaire. */
  allowedUsers?: string[];
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
  // Au-delà de « une identité » : **laquelle**. Sans cette liste, n'importe quel
  // appareil du tailnet lisait les secrets d'une app (/env renvoie les valeurs)
  // et pilotait tout — l'ACL Tailscale était la seule défense. Relevé par le
  // recon du 4 octobre 2026. Comparaison en minuscules, sur le login comme sur
  // le nom (viewerOf préfère le login). Vide = comportement d'avant, assumé.
  if (deps.allowedUsers !== undefined && deps.allowedUsers.length > 0
      && !deps.allowedUsers.includes(viewer.toLowerCase())) {
    return text(403, "identité non autorisée sur ce DBox\n");
  }

  const segments = path.split("/").filter((segment) => segment !== "");

  if (method === "GET" || method === "HEAD") {
    if (segments.length === 0) {
      const notice = deps.authkeyNotice === undefined ? null : await deps.authkeyNotice();
      const adminNotice = deps.adminAuthkeyNotice === undefined ? null : await deps.adminAuthkeyNotice();
      const machines = deps.machines === undefined ? [] : await deps.machines();
      const canAddLocal = deps.actions?.addLocal !== undefined;
      const projects = canAddLocal && deps.listWorkspaces !== undefined ? await deps.listWorkspaces() : [];
      const entries = await deps.scan();
      const orphans = deps.orphansReport === undefined ? null : await deps.orphansReport();
      const tagReport = deps.tagReport === undefined ? null : await deps.tagReport();
      return html(
        renderPage(
          entries,
          deps.now(),
          viewer,
          deps.actions !== undefined,
          notice,
          machines,
          canAddLocal ? (deps.workspacesRoot ?? null) : null,
          projects,
          adminNotice,
          await extrasPour(entries, deps),
          { orphans, tag: tagReport },
          deps.headscaleAuthkeyNotice === undefined ? null : await deps.headscaleAuthkeyNotice(),
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
          deps.traefik ?? null,
          deps.version ?? null,
          deps.diagnostic !== undefined,
          deps.headscale === undefined ? null : await deps.headscale(),
          deps.headscaleAuthkeyNotice === undefined ? null : await deps.headscaleAuthkeyNotice(),
          deps.headscaleCertNotice === undefined ? null : await deps.headscaleCertNotice(),
        ),
      );
    }
    if (path === "/api/diagnostic") {
      if (deps.diagnostic === undefined) return text(404, "diagnostic non disponible sur ce daemon\n");
      return html(diagnosticFragment(await deps.diagnostic()));
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
    if (path === "/api/apps/apercu") return await apercuRoute(query, deps);
    if (path === "/api/apps/list") {
      const entries = await deps.scan();
      return html(renderList(entries, deps.now(), deps.actions !== undefined, await extrasPour(entries, deps)));
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
        // Filtré ici plutôt que dans la page : le bloc est remplacé toutes les
        // 3 s, un filtre côté page serait perdu à chaque passage. Une simple
        // sous-chaîne, sans regex — rien à interpréter dans ce qu'on tape.
        const filtre = (query.get("q") ?? "").trim().slice(0, 100);
        const output = await logsOf(entry, deps.actions.compose, lines);
        const garde =
          filtre === ""
            ? output
            : output
                .split("\n")
                .filter((ligne) => ligne.toLowerCase().includes(filtre.toLowerCase()))
                .join("\n");
        return html(logsFragment(entry.descriptor.app, entry.descriptor.target, lines, garde, filtre));
      }
      if (segments[4] === "env") {
        const entries = await readEnv(entry, deps.actions.readFile);
        return html(envPanelFragment(entry.descriptor.app, entry.descriptor.target, entries));
      }
      if (segments[4] === "fichiers") {
        const fichiers = await readGeneratedFiles(entry, deps.actions.readFile);
        return html(
          fichiersPanelFragment(entry.descriptor.source, entry.state?.previousTag ?? null, fichiers),
        );
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

  if (action === "start" || action === "stop" || action === "restart") {
    // Même garde que `remove` : un redéploiement construit puis fait `up -d` ;
    // un redémarrage glissé entre les deux relancerait l'ancien conteneur, et
    // un arrêt couperait une cible que le redéploiement est en train de lever.
    if (actions.jobs.runningFor(label) !== null) {
      return html(actionResult(false, "un redéploiement est en cours — réessaie une fois terminé", false));
    }
    const result = await (action === "start"
      ? startTarget(entry, actions.compose)
      : action === "stop"
        ? stopTarget(entry, actions.compose)
        : restartTarget(entry, actions.compose));
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

  const choice: NewTargetChoice = { mode: mode as NewTargetMode, port, command };

  // Réservés au devcontainer : ailleurs le manifeste les refuserait, et les
  // laisser passer écrirait un dbox.toml invalide qu'on ne pourrait plus relire.
  // Posées seulement si renseignées — une clé à `undefined` n'est pas la même
  // chose qu'une clé absente pour qui compare l'objet.
  if (mode === "devcontainer") {
    const image = form.get("image")?.trim();
    const dockerfile = form.get("dockerfile")?.trim();
    if (image !== undefined && image !== "") choice.image = image;
    if (dockerfile !== undefined && dockerfile !== "") choice.dockerfile = dockerfile;
  }

  return { ok: true, choice };
}

/**
 * Les champs cachés par Alpine partent quand même avec le formulaire : choisir
 * un dossier local puis revenir à « Dépôt git » envoyait les deux, et le
 * chemin l'emportait — on ajoutait le dossier au lieu de cloner l'URL. Le
 * formulaire dit maintenant quelle source il montre (`source`), et c'est elle
 * qui décide. Sans ce champ (un appel direct à l'API), l'ancienne règle tient.
 */
function sourceDuFormulaire(form: URLSearchParams): { url: string; path: string } {
  const url = (form.get("url") ?? "").trim();
  const path = (form.get("path") ?? "").trim();
  const source = form.get("source");
  if (source === "git") return { url, path: "" };
  if (source === "local") return { url: "", path };
  return { url, path };
}

async function apercuRoute(query: URLSearchParams, deps: Deps): Promise<Response> {
  // Un champ pas encore rempli n'est pas une faute : l'aperçu attend, il ne
  // reproche pas. Les vrais refus (port hors bornes) restent ceux de parseChoice.
  const mode = query.get("mode");
  if (mode !== null && mode !== "deployed" && ((query.get("port") ?? "") === "" || (query.get("command") ?? "").trim() === "")) {
    return html(apercuFragment({ contenu: null, note: "indique le port et la commande pour voir le manifeste" }));
  }
  const parsed = parseChoice(query);
  if (!parsed.ok) return html(apercuFragment({ contenu: null, note: parsed.detail }));
  const { url, path } = sourceDuFormulaire(query);
  const local = query.get("source") === "local";

  let dossier: string | null = null;
  if (local && path !== "") {
    if (deps.workspacesRoot === undefined) {
      return html(apercuFragment({ contenu: null, note: "pas de racine de dossiers locaux sur cette machine" }));
    }
    try {
      dossier = resolveWorkspacePath(deps.workspacesRoot, path);
    } catch (error) {
      return html(apercuFragment({ contenu: null, note: (error as Error).message }));
    }
  }
  const lire = deps.actions?.readFile ?? (() => Promise.reject(new Error("lecture indisponible")));
  const apercu = await apercuManifeste(
    { source: local ? "local" : "git", url, name: query.get("name")?.trim() || null, dossier },
    parsed.choice,
    lire,
  ).catch((error: Error) => ({ contenu: null, note: error.message }));
  return html(apercuFragment(apercu));
}

async function addApp(body: string, actions: Actions): Promise<Response> {
  const form = new URLSearchParams(body);
  const { url, path } = sourceDuFormulaire(form);
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

/**
 * Les lignes de services compagnons du formulaire. Une ligne entièrement vide
 * est un « Ajouter » jamais rempli : ignorée en silence. Une ligne à moitié
 * remplie est une vraie faute de saisie, signalée — même règle que le panneau
 * des machines connues.
 *
 * Le reste (nom valide, image non vide, chemin absolu) n'est pas revérifié
 * ici : `parseManifest` le fait déjà, et mieux.
 */
function parseServices(
  form: URLSearchParams,
): { ok: true; services: Record<string, { image: string; data: string | null }> } | { ok: false; detail: string } {
  const noms = form.getAll("serviceNom");
  const images = form.getAll("serviceImage");
  const donnees = form.getAll("serviceData");

  const services: Record<string, { image: string; data: string | null }> = {};

  for (let i = 0; i < noms.length; i++) {
    const nom = (noms[i] ?? "").trim();
    const image = (images[i] ?? "").trim();
    const data = (donnees[i] ?? "").trim();

    if (nom === "" && image === "" && data === "") continue;
    if (nom === "" || image === "") {
      return { ok: false, detail: "un service compagnon veut au moins un nom et une image" };
    }
    if (services[nom] !== undefined) {
      return { ok: false, detail: `deux services nommés « ${nom} » — Docker n'en garderait qu'un` };
    }
    services[nom] = { image, data: data === "" ? null : data };
  }

  return { ok: true, services };
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

  // Un champ vidé remet le réglage à son défaut — c'est la seule façon de le
  // retirer depuis un formulaire. Rien n'est validé ici : `writeManifestTarget`
  // repasse par `parseManifest`, donc une saisie fautive ressort avec le
  // message exact d'un dbox.toml écrit à la main, sans validation dupliquée.
  const optionnel = (nom: string): string | null => {
    const valeur = form.get(nom)?.trim();
    return valeur === undefined || valeur === "" ? null : valeur;
  };

  changes.tsTag = optionnel("tsTag");
  // Le backend vit sur toutes les cibles (y compris workspace). Vide =
  // null = défaut machine. writeManifestTarget re-valide (tailscale/headscale).
  changes.backend = optionnel("backend");

  if (current.mode === "devcontainer") {
    // `image` a un défaut, pas `dockerfile` : vider le premier le rétablit,
    // vider le second retire la construction.
    const image = optionnel("image");
    if (image !== null) changes.image = image;
    changes.dockerfile = optionnel("dockerfile");
  }

  if (current.mode !== "workspace") {
    changes.autoDeploy = form.has("autoDeploy");
    changes.publicDomain = optionnel("publicDomain");
    changes.data = optionnel("data");

    const services = parseServices(form);
    if (!services.ok) return html(actionResult(false, services.detail, false));
    // Le formulaire ne couvre que nom/image/data : on préserve `command` et
    // `healthcheck` que le dbox.toml portait pour un compagnon de même nom,
    // plutôt que de les effacer en silence à chaque enregistrement.
    const courants = current.services; // non-workspace ici : les compagnons existent
    changes.services = Object.fromEntries(
      Object.entries(services.services).map(([nom, svc]) => {
        const ancien = courants[nom];
        return [nom, { image: svc.image, data: svc.data, command: ancien?.command ?? null, healthcheck: ancien?.healthcheck ?? null }];
      }),
    );
  }

  try {
    await writeManifestTarget(entry, changes, actions.readFile, actions.writeFile);
    const { app, target } = entry.descriptor;
    return html(
      actionResult(true, "enregistré — s'applique au prochain déploiement", false, redeployerMaintenant(app, target)),
    );
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

  // Le sélecteur fait `location.href = url` : une URL non http(s) y exécuterait
  // du code (javascript:…) chez quiconque choisit l'entrée. Refusé à l'écriture.
  const mauvaise = entries.find((e) => !estUrlWeb(e.url));
  if (mauvaise !== undefined) {
    return html(actionResult(false, `« ${mauvaise.url} » n'est pas une adresse http(s)`, false));
  }

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

  // Même garde que start/stop/restart : appliquer fait un `up -d`, et pendant
  // la construction le Compose pointe déjà vers une image qui n'existe pas encore.
  if (actions.jobs.runningFor(`${entry.descriptor.app}/${entry.descriptor.target}`) !== null) {
    return html(actionResult(false, "un redéploiement est en cours — réessaie une fois terminé", false));
  }

  await writeEnv(entry, entries, actions.writeFile);

  // Recréer le conteneur suffit : l'image n'a pas changé, seul le fichier lu
  // au démarrage a changé. Et rien n'est recréé si la cible est à l'arrêt.
  const applied = await applyEnv(entry, actions.compose);
  if (applied === null) {
    return html(actionResult(true, "cible à l'arrêt : pris en compte au démarrage", false));
  }
  return html(actionResult(applied.code === 0, applied.code === 0 ? "enregistré et appliqué" : applied.stderr || applied.stdout, false));
}

/**
 * Ce que les cartes montrent en plus du registre : la tâche en cours de
 * chaque cible (pour que recharger la page n'en perde pas le suivi), et ce
 * qu'on sait de sa version. Une erreur ici ne casse jamais la page : la
 * carte retombe sur ce qu'elle montrait avant.
 */
async function extrasPour(entries: Entry[], deps: Deps): Promise<Extras> {
  const jobs = new Map<string, JobView>();
  for (const job of deps.actions?.jobs.list() ?? []) {
    if (job.status === "en cours" && !jobs.has(job.label)) jobs.set(job.label, job);
  }

  const versions = new Map<string, VersionInfo>();
  const calcule = deps.versionInfo;
  if (calcule !== undefined) {
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.state === null) return;
        const info = await calcule(entry.descriptor.source, entry.state.tag).catch(() => null);
        if (info !== null) versions.set(cleCible(entry.descriptor.app, entry.descriptor.target), info);
      }),
    );
  }
  return { jobs, versions };
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

/**
 * Posés sur **toute** réponse, au seul point de sortie réel : le tableau de
 * bord ne doit jamais s'afficher dans un cadre (clickjacking — un site tiers
 * encadre la page et fait cliquer une action à l'insu de la personne, vérifié
 * à la revue du 4 octobre 2026), ni voir son type deviné. `route` reste pur et
 * ignore le transport ; ces en-têtes ne peuvent pas être oubliés sur un chemin.
 */
export const ENTETES_SECURITE: Record<string, string> = {
  "x-frame-options": "DENY",
  // frame-ancestors : pas de cadrage. object-src/base-uri : verrous bon marché.
  // Pas de `default-src 'self'` : Alpine évalue ses expressions (Function),
  // ce qui demanderait `unsafe-eval`, et toute la page est en inline — le gain
  // d'un verrou qu'il faut rouvrir en grand serait illusoire.
  "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  // TLS toujours fourni par le sidecar Tailscale ; HSTS l'inscrit côté client.
  "strict-transport-security": "max-age=31536000",
  "referrer-policy": "no-referrer",
};

export function createServer(deps: Deps) {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://dbox");
    readBody(request)
      .then((body) =>
        route(request.method ?? "GET", url.pathname, request.headers, deps, url.searchParams, body),
      )
      .then((result) => {
        response.writeHead(result.status, { ...ENTETES_SECURITE, ...result.headers });
        response.end(request.method === "HEAD" ? undefined : result.body);
      })
      .catch((error: Error) => {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(`erreur interne : ${error.message}\n`);
      });
  });
}
