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

export interface WorkspaceTarget extends Checked, Tagged, Forwardable {
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

export interface DevcontainerTarget extends Checked, Pollable, Tagged, Forwardable {
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
export interface DeployedTarget extends Checked, Pollable, Tagged, Forwardable {
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
const MAX_LABEL = 63;

/** Un tag Tailscale : « tag: » suivi d'un label, comme `tag:dbox`. */
const TS_TAG = /^tag:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** La cible « prod » porte le nom nu ; les autres sont suffixées. */
export function hostnameFor(name: string, target: string): string {
  return target === "prod" ? name : `${name}-${target}`;
}

const MODES: readonly Mode[] = ["workspace", "devcontainer", "deployed"];
const KEYS_BY_MODE: Record<Mode, readonly string[]> = {
  workspace: ["mode", "port", "command", "health", "ts_tag", "ssh_port"],
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
  ],
  deployed: ["mode", "port", "dockerfile", "health", "data", "auto_deploy", "ts_tag", "ssh_port"],
};

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
    if (target.sshPort !== null) lines.push(`ssh_port = ${target.sshPort}`);

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

  const rawData = raw["data"];
  let data: string | null = null;
  if (rawData !== undefined) {
    if (typeof rawData !== "string" || !rawData.startsWith("/")) {
      fail(`${path}.data`, `« data » doit être un chemin absolu dans le conteneur (reçu « ${String(rawData)} »)`);
    }
    data = rawData as string;
  }

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
  };
}

export { TomlError };
