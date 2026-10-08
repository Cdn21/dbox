/**
 * `dbox.toml` → manifeste validé.
 *
 * Les messages d'erreur sont le produit de ce module : ils remplacent la
 * demi-heure de débogage qu'on passerait sinon à comprendre pourquoi le nœud
 * n'apparaît pas sur le tailnet.
 */

import { parseToml, TomlError, type TomlTable } from "./toml.ts";

export type Mode = "workspace" | "devcontainer" | "deployed";

/** Chemin interrogé après un déploiement pour décider s'il a réussi. */
interface Checked {
  health: string;
}

/**
 * Le tag ACL de cette cible précisément — pour l'isoler des autres apps de la
 * même machine derrière une policy Tailscale distincte. `null` : hérite du
 * tag de la machine (`--ts-tag`), le cas courant. Poser un tag ici ne suffit
 * pas : il doit déjà exister dans `tagOwners` de la policy du tailnet, sans
 * quoi le sidecar échoue à s'enregistrer — DBox ne peut pas éditer cette
 * policy à sa place.
 */
interface Tagged {
  tsTag: string | null;
}

/**
 * Port TCP brut, forcé sur le 22 du sidecar (`tsserve.ts`) — jamais un autre
 * numéro : le seul cas d'usage est du SSH, et faire deviner un port externe
 * différent du 22 surprendrait n'importe quel client `git`/`ssh` standard.
 * `null` : pas de forward, le sidecar ne parle que HTTPS, comme partout
 * ailleurs.
 */
interface Forwardable {
  sshPort: number | null;
}

/**
 * Domaine public par lequel cette cible est **aussi** joignable, en plus de son
 * sidecar privé — additif, jamais à sa place : le sidecar continue de tourner,
 * ce qui garde un accès par le tailnet même si la route publique casse.
 * `null` : cible strictement privée, le comportement par défaut.
 *
 * Jamais hérité d'un défaut de machine, contrairement à `ts_tag` : une cible
 * n'est publique que si son propre `dbox.toml` le dit. Un réglage machine qui
 * rendrait des cibles publiques sans le vouloir serait le pire genre de bug.
 *
 * Absent du mode `workspace` : sans conteneur d'app, il n'y a rien sur quoi
 * poser les labels que Traefik découvre, et son provider Docker ne sait pas
 * router vers un processus qui tourne sur l'hôte.
 */
interface Published {
  publicDomain: string | null;
}

/**
 * Un service compagnon : une base, un cache, une file — ce dont l'app a besoin
 * à côté d'elle. L'app le joint par son nom sur le réseau interne (`db:5432`).
 *
 * Volontairement pauvre : une image toute faite, au plus un volume nommé, une
 * commande et un contrôle de santé. Pas de build, pas de ports, **pas de montage
 * de l'hôte** — c'est cette impossibilité d'exprimer un chemin hôte qui préserve
 * l'invariant 7 (aucune app ne peut réclamer le socket Docker). `command` et
 * `healthcheck` s'exécutent dans le conteneur du compagnon, jamais sur l'hôte :
 * ils n'ouvrent aucune surface. Au-delà, la réponse reste d'écrire son propre
 * compose : DBox est jetable, c'est prévu.
 */
export interface CompanionService {
  image: string;
  /** Chemin dans le conteneur, monté sur un volume nommé. `null` : sans état. */
  data: string | null;
  /** Commande du conteneur (ex. `postgres -c max_connections=200`). `null` :
   * l'entrypoint par défaut de l'image. */
  command: string | null;
  /** Commande de santé exécutée dans le conteneur (ex. `pg_isready -U app`).
   * Quand elle est posée, l'app attend que ce compagnon soit **sain** avant de
   * démarrer (`depends_on: condition: service_healthy`), pas seulement lancé.
   * `null` : pas de contrôle de santé, l'app ne fait que l'attendre démarré. */
  healthcheck: string | null;
}

/**
 * Les compagnons de cette cible, par nom. Objet vide quand il n'y en a pas —
 * jamais `null`, pour éviter un cas de plus à traiter partout.
 *
 * Absent du mode `workspace` : sans conteneur d'app, un compagnon sur le réseau
 * interne serait injoignable depuis le processus qui tourne sur l'hôte, et
 * publier un port pour l'atteindre est exclu (invariant 1).
 */
interface Companioned {
  services: Record<string, CompanionService>;
}

export type Backend = "tailscale" | "headscale";

/**
 * Le backend d'exposition de cette cible précisément — « tailscale »
 * (coordination SaaS, TLS automatique via `tailscale cert`) ou « headscale »
 * (coordination auto-hébergée ; `tailscale serve` n'a pas d'équivalent à
 * `tailscale cert` contre un Headscale, donc un Caddy voisin termine le TLS
 * avec un certificat wildcard externe, jamais obtenu par DBox — voir
 * `backendFor` et `caddyService` dans compose.ts). `null` : hérite du backend
 * par défaut de la machine (`--backend`), le cas courant, comme `ts_tag`.
 */
interface Backed {
  backend: Backend | null;
}

export interface WorkspaceTarget extends Checked, Tagged, Forwardable, Backed {
  mode: "workspace";
  port: number;
  command: string;
}
/**
 * Redéploiement automatique quand le dépôt distant avance — jamais instantané :
 * un sondage, pas un webhook, pour ne rien exposer sur internet. `false` par
 * défaut, et absent du mode `workspace` : sans conteneur d'app, il n'y a rien
 * à reconstruire.
 */
interface Pollable {
  autoDeploy: boolean;
}

export interface DevcontainerTarget extends Checked, Pollable, Tagged, Forwardable, Published, Companioned, Backed {
  mode: "devcontainer";
  port: number;
  command: string;
  image: string;
  /**
   * Dockerfile de l'environnement de développement, quand une image toute faite
   * ne suffit pas — le cas dès qu'un projet mêle deux runtimes. `null` pour
   * utiliser `image` telle quelle.
   */
  dockerfile: string | null;
  data: string | null;
}
export interface DeployedTarget extends Checked, Pollable, Tagged, Forwardable, Published, Companioned, Backed {
  mode: "deployed";
  port: number;
  dockerfile: string;
  /** Chemin, dans le conteneur, monté sur un volume nommé qui survit aux
   * déploiements. `null` quand l'app ne stocke rien. */
  data: string | null;
}
export type Target = WorkspaceTarget | DevcontainerTarget | DeployedTarget;

export interface Manifest {
  name: string;
  targets: Record<string, Target>;
}

export class ManifestError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(line > 0 ? `ligne ${line} : ${message}` : message);
    this.name = "ManifestError";
    this.line = line;
  }
}

/** Un label DNS : c'est un nom de machine sur le tailnet, pas un nom de projet. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Un nom d'app ou de cible valide — exporté pour le registre, qui relit des
 * `dbox.json` venus du disque et ne doit pas croire ce qu'ils annoncent. */
export function isLabel(name: string): boolean {
  return LABEL.test(name);
}
const MAX_LABEL = 63;

/** Un tag Tailscale : « tag: » suivi d'un label, comme `tag:dbox`. */
const TS_TAG = /^tag:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Un domaine public : des labels DNS séparés par des points. Volontairement
 * simple — DBox ne valide pas contre la liste réelle des TLD, il attrape les
 * fautes de frappe évidentes (une URL entière, un chemin, un nom sans point).
 */
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** La cible « prod » porte le nom nu ; les autres sont suffixées. */
export function hostnameFor(name: string, target: string): string {
  return target === "prod" ? name : `${name}-${target}`;
}

const MODES: readonly Mode[] = ["workspace", "devcontainer", "deployed"];
const KEYS_BY_MODE: Record<Mode, readonly string[]> = {
  workspace: ["mode", "port", "command", "health", "ts_tag", "ssh_port", "backend"],
  devcontainer: [
    "mode",
    "port",
    "command",
    "image",
    "dockerfile",
    "health",
    "data",
    "auto_deploy",
    "ts_tag",
    "ssh_port",
    "public_domain",
    "services",
    "backend",
  ],
  deployed: [
    "mode",
    "port",
    "dockerfile",
    "health",
    "data",
    "auto_deploy",
    "ts_tag",
    "ssh_port",
    "public_domain",
    "services",
    "backend",
  ],
};

const BACKENDS: readonly Backend[] = ["tailscale", "headscale"];

/**
 * Noms qu'un compagnon ne peut pas porter : ils entreraient en collision avec
 * les services que DBox génère lui-même, et le compose produit serait
 * silencieusement faux plutôt que refusé.
 */
const SERVICES_RESERVES: readonly string[] = ["app", "tailscale", "caddy"];

/** Les seules clés qu'un compagnon accepte — voir `CompanionService`. */
const CLES_COMPAGNON: readonly string[] = ["image", "data", "command", "healthcheck"];

const DEFAULT_DEV_IMAGE = "node:24-bookworm-slim";
const DEFAULT_DOCKERFILE = "Dockerfile";
const DEFAULT_HEALTH = "/";

export function parseManifest(source: string): Manifest {
  const { data, lines } = parseToml(source);
  const at = (path: string) => lines.get(path) ?? 0;
  const fail = (path: string, message: string): never => {
    throw new ManifestError(message, at(path));
  };

  for (const key of Object.keys(data)) {
    if (key !== "name" && key !== "targets") {
      fail(key, `clé inconnue « ${key} » — attendu « name » ou « targets »`);
    }
  }

  const name = data["name"];
  if (name === undefined) throw new ManifestError("« name » est obligatoire", 0);
  if (typeof name !== "string") fail("name", "« name » doit être une chaîne");
  validateName(name as string, fail);

  const targets = data["targets"];
  if (targets === undefined) throw new ManifestError("aucune cible : il faut au moins un [targets.…]", 0);
  if (typeof targets !== "object") fail("targets", "« targets » doit être une table");

  const parsed: Record<string, Target> = {};

  for (const [targetName, raw] of Object.entries(targets as TomlTable)) {
    const path = `targets.${targetName}`;
    if (typeof raw !== "object") fail(path, `« ${path} » doit être une table`);
    if (!LABEL.test(targetName)) {
      fail(path, `« ${targetName} » n'est pas un nom de cible valide (minuscules, chiffres, tirets)`);
    }

    const hostname = hostnameFor(name as string, targetName);
    if (hostname.length > MAX_LABEL) {
      fail(path, `le nom de machine « ${hostname} » fait ${hostname.length} caractères, maximum ${MAX_LABEL}`);
    }
    // Deux cibles d'un même manifeste ne peuvent pas entrer en collision : « prod »
    // donne le nom nu, les autres sont suffixées par leur nom, distinct par
    // construction. La collision possible est entre deux apps — l'app « budget »
    // avec sa cible « dev » et une app nommée « budget-dev » — et elle ne se voit
    // pas d'ici. C'est au registre des apps (étape 2) de la refuser.
    parsed[targetName] = parseTarget(raw as TomlTable, path, fail);
  }

  if (Object.keys(parsed).length === 0) {
    throw new ManifestError("aucune cible : il faut au moins un [targets.…]", at("targets"));
  }

  return { name: name as string, targets: parsed };
}

/**
 * L'inverse de `parseManifest` — sert le panneau de configuration du tableau
 * de bord. N'écrit que ce qui diffère du défaut, comme on l'écrirait à la
 * main : un `dbox.toml` réenregistré doit rester lisible, pas une purge
 * exhaustive de chaque champ possible.
 *
 * Les commentaires de l'original ne survivent pas — le parseur TOML ne les
 * garde pas. Assumé, comme pour `config.toml`.
 */
export function serializeManifest(manifest: Manifest): string {
  const lines = [`name = ${str(manifest.name)}`, ""];

  for (const [name, target] of Object.entries(manifest.targets)) {
    lines.push(`[targets.${name}]`, `mode = ${str(target.mode)}`, `port = ${target.port}`);

    if (target.mode !== "deployed") lines.push(`command = ${str(target.command)}`);
    if (target.mode === "devcontainer") {
      if (target.image !== DEFAULT_DEV_IMAGE) lines.push(`image = ${str(target.image)}`);
      if (target.dockerfile !== null) lines.push(`dockerfile = ${str(target.dockerfile)}`);
    }
    if (target.mode === "deployed" && target.dockerfile !== DEFAULT_DOCKERFILE) {
      lines.push(`dockerfile = ${str(target.dockerfile)}`);
    }
    if (target.mode !== "workspace") {
      if (target.data !== null) lines.push(`data = ${str(target.data)}`);
      if (target.autoDeploy) lines.push(`auto_deploy = true`);
    }
    if (target.health !== DEFAULT_HEALTH) lines.push(`health = ${str(target.health)}`);
    if (target.tsTag !== null) lines.push(`ts_tag = ${str(target.tsTag)}`);
    if (target.backend !== null) lines.push(`backend = ${str(target.backend)}`);
    if (target.sshPort !== null) lines.push(`ssh_port = ${target.sshPort}`);
    if (target.mode !== "workspace" && target.publicDomain !== null) {
      lines.push(`public_domain = ${str(target.publicDomain)}`);
    }

    // Les sous-tables viennent **après** toutes les clés scalaires de la cible :
    // en TOML, ce qui suit un `[a.b.c]` lui appartient, donc un scalaire écrit
    // ici finirait dans le compagnon au lieu de la cible.
    if (target.mode !== "workspace") {
      for (const [nom, service] of Object.entries(target.services)) {
        lines.push("", `[targets.${name}.services.${nom}]`, `image = ${str(service.image)}`);
        if (service.data !== null) lines.push(`data = ${str(service.data)}`);
        if (service.command !== null) lines.push(`command = ${str(service.command)}`);
        if (service.healthcheck !== null) lines.push(`healthcheck = ${str(service.healthcheck)}`);
      }
    }

    lines.push("");
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function str(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function validateName(name: string, fail: (path: string, message: string) => never): void {
  if (LABEL.test(name)) return;

  const suggestion = name.toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9-]/g, "");
  const hint = LABEL.test(suggestion) ? ` — essaie « ${suggestion} »` : "";

  if (name.includes("_")) {
    fail("name", `« ${name} » contient un souligné : un nom de machine n'accepte que minuscules, chiffres et tirets${hint}`);
  }
  if (/[A-Z]/.test(name)) {
    fail("name", `« ${name} » contient une majuscule : un nom de machine est en minuscules${hint}`);
  }
  if (name.length > MAX_LABEL) {
    fail("name", `« ${name} » fait ${name.length} caractères, maximum ${MAX_LABEL}`);
  }
  fail("name", `« ${name} » n'est pas un nom de machine valide (minuscules, chiffres, tirets)${hint}`);
}

/**
 * Les compagnons d'une cible. Absent = aucun, pas une erreur.
 *
 * Chaque clé inconnue explose plutôt que de disparaître (invariant 15) : un
 * `command` ou un `ports` écrit ici serait ignoré en silence sinon, et
 * l'utilisateur chercherait longtemps pourquoi son compose n'en tient pas
 * compte.
 */
/**
 * Un chemin de volume dans le conteneur. Absolu, et **sans deux-points** : la
 * valeur est concaténée en `volume:chemin` pour Compose, où un `:` de plus est
 * lu comme des options de montage. Écrire « /data:ro » donnerait donc un
 * montage en lecture seule au lieu du chemin demandé — un sens changé en
 * silence, ce que ce parseur ne fait jamais.
 */
function parseDataPath(
  raw: unknown,
  path: string,
  fail: (path: string, message: string) => never,
): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !raw.startsWith("/")) {
    fail(path, `« data » doit être un chemin absolu dans le conteneur (reçu « ${String(raw)} »)`);
  }
  if ((raw as string).includes(":")) {
    fail(
      path,
      `« data » ne peut pas contenir « : » (reçu « ${String(raw)} ») — Docker y lirait des options ` +
        `de montage, et « /data:ro » deviendrait un montage en lecture seule`,
    );
  }
  return raw as string;
}

function parseServices(
  raw: unknown,
  path: string,
  fail: (path: string, message: string) => never,
): Record<string, CompanionService> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${path}.services`, `« services » doit être une table ([${path}.services.nom])`);
  }

  const services: Record<string, CompanionService> = {};

  for (const [nom, brut] of Object.entries(raw as TomlTable)) {
    const chemin = `${path}.services.${nom}`;

    // Le nom sert d'hôte sur le réseau interne : c'est ainsi que l'app le joint.
    if (!LABEL.test(nom)) {
      fail(chemin, `« ${nom} » n'est pas un nom de service valide (minuscules, chiffres, tirets)`);
    }
    if (SERVICES_RESERVES.includes(nom)) {
      fail(chemin, `« ${nom} » est réservé — DBox génère déjà un service de ce nom`);
    }
    if (typeof brut !== "object" || brut === null || Array.isArray(brut)) {
      fail(chemin, `« ${chemin} » doit être une table`);
    }

    for (const cle of Object.keys(brut as TomlTable)) {
      if (CLES_COMPAGNON.includes(cle)) continue;
      fail(
        `${chemin}.${cle}`,
        `clé « ${cle} » inattendue dans un service — seuls ${CLES_COMPAGNON.join(" et ")} sont acceptés ` +
          `(un compagnon est une image toute faite ; pour davantage, écris ton propre compose)`,
      );
    }

    const image = (brut as TomlTable)["image"];
    if (image === undefined) fail(chemin, `« ${chemin}.image » est obligatoire`);
    if (typeof image !== "string" || image === "") {
      fail(`${chemin}.image`, "« image » doit être une chaîne non vide");
    }

    const data = parseDataPath((brut as TomlTable)["data"], `${chemin}.data`, fail);
    const lireChaine = (cle: string): string | null => {
      const v = (brut as TomlTable)[cle];
      if (v === undefined) return null;
      if (typeof v !== "string" || v === "") fail(`${chemin}.${cle}`, `« ${cle} » doit être une chaîne non vide`);
      return v as string;
    };

    services[nom] = {
      image: image as string,
      data,
      command: lireChaine("command"),
      healthcheck: lireChaine("healthcheck"),
    };
  }

  return services;
}

function parseTarget(
  raw: TomlTable,
  path: string,
  fail: (path: string, message: string) => never,
): Target {
  const mode = raw["mode"];
  if (mode === undefined) fail(path, `« ${path}.mode » est obligatoire (${MODES.join(", ")})`);
  if (typeof mode !== "string" || !MODES.includes(mode as Mode)) {
    fail(`${path}.mode`, `mode « ${String(mode)} » inconnu — attendu ${MODES.join(", ")}`);
  }

  const allowed = KEYS_BY_MODE[mode as Mode];
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    const elsewhere = MODES.filter((m) => KEYS_BY_MODE[m].includes(key));
    const hint = elsewhere.length > 0 ? ` (elle n'existe qu'en mode ${elsewhere.join(" ou ")})` : "";
    fail(`${path}.${key}`, `clé « ${key} » inattendue en mode ${mode}${hint}`);
  }

  const port = raw["port"];
  if (port === undefined) fail(path, `« ${path}.port » est obligatoire`);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${path}.port`, `port « ${String(port)} » invalide — un entier entre 1 et 65535`);
  }

  const health = raw["health"] ?? DEFAULT_HEALTH;
  if (typeof health !== "string" || !health.startsWith("/")) {
    fail(`${path}.health`, `« health » doit être un chemin commençant par « / » (reçu « ${String(health)} »)`);
  }

  const data = parseDataPath(raw["data"], `${path}.data`, fail);

  const autoDeploy = raw["auto_deploy"] ?? false;
  if (typeof autoDeploy !== "boolean") {
    fail(`${path}.auto_deploy`, `« auto_deploy » doit être true ou false (reçu « ${String(autoDeploy)} »)`);
  }

  const rawSshPort = raw["ssh_port"];
  let sshPort: number | null = null;
  if (rawSshPort !== undefined) {
    if (typeof rawSshPort !== "number" || !Number.isInteger(rawSshPort) || rawSshPort < 1 || rawSshPort > 65535) {
      fail(`${path}.ssh_port`, `« ssh_port » invalide — un entier entre 1 et 65535 (reçu « ${String(rawSshPort)} »)`);
    }
    sshPort = rawSshPort;
  }

  const rawTsTag = raw["ts_tag"];
  let tsTag: string | null = null;
  if (rawTsTag !== undefined) {
    if (typeof rawTsTag !== "string" || !TS_TAG.test(rawTsTag)) {
      fail(
        `${path}.ts_tag`,
        `« ts_tag » doit ressembler à « tag:mon-tag » (reçu « ${String(rawTsTag)} ») — et déjà exister ` +
          `dans tagOwners de la policy du tailnet, sans quoi le sidecar échoue à s'enregistrer`,
      );
    }
    tsTag = rawTsTag;
  }

  const rawPublicDomain = raw["public_domain"];
  let publicDomain: string | null = null;
  if (rawPublicDomain !== undefined) {
    if (typeof rawPublicDomain !== "string" || !DOMAIN.test(rawPublicDomain)) {
      fail(
        `${path}.public_domain`,
        `« public_domain » doit être un nom de domaine, sans schéma ni chemin ` +
          `(reçu « ${String(rawPublicDomain)} »)`,
      );
    }
    publicDomain = rawPublicDomain;
  }

  const rawBackend = raw["backend"];
  let backend: Backend | null = null;
  if (rawBackend !== undefined) {
    if (typeof rawBackend !== "string" || !BACKENDS.includes(rawBackend as Backend)) {
      fail(`${path}.backend`, `« backend » doit être « tailscale » ou « headscale » (reçu « ${String(rawBackend)} »)`);
    }
    backend = rawBackend as Backend;
  }

  const services = parseServices(raw["services"], path, fail);

  if (mode === "deployed") {
    const dockerfile = raw["dockerfile"] ?? DEFAULT_DOCKERFILE;
    if (typeof dockerfile !== "string" || dockerfile === "") {
      fail(`${path}.dockerfile`, "« dockerfile » doit être un chemin non vide");
    }
    return {
      mode: "deployed",
      port: port as number,
      dockerfile: dockerfile as string,
      health: health as string,
      data,
      autoDeploy: autoDeploy as boolean,
      tsTag,
      sshPort,
      publicDomain,
      services,
      backend,
    };
  }

  const command = raw["command"];
  if (command === undefined) {
    fail(path, `« ${path}.command » est obligatoire en mode ${mode}`);
  }
  if (typeof command !== "string" || command.trim() === "") {
    fail(`${path}.command`, "« command » doit être une chaîne non vide");
  }

  if (mode === "workspace") {
    return {
      mode: "workspace",
      port: port as number,
      command: command as string,
      health: health as string,
      tsTag,
      sshPort,
      backend,
    };
  }

  const image = raw["image"] ?? DEFAULT_DEV_IMAGE;
  if (typeof image !== "string" || image === "") {
    fail(`${path}.image`, "« image » doit être une chaîne non vide");
  }
  const devDockerfile = raw["dockerfile"];
  if (devDockerfile !== undefined && (typeof devDockerfile !== "string" || devDockerfile === "")) {
    fail(`${path}.dockerfile`, "« dockerfile » doit être un chemin non vide");
  }
  return {
    mode: "devcontainer",
    port: port as number,
    command: command as string,
    image: image as string,
    dockerfile: (devDockerfile as string | undefined) ?? null,
    health: health as string,
    data,
    autoDeploy: autoDeploy as boolean,
    tsTag,
    sshPort,
    publicDomain,
    services,
    backend,
  };
}

export { TomlError };
