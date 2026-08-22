/**
 * La configuration de la machine.
 *
 * Ce qui ne change jamais d'une commande à l'autre — la racine, le tailnet, le
 * tag — n'a rien à faire sur la ligne de commande. On l'écrit une fois, et
 * `dbox up` redevient `dbox up`.
 *
 * Les options de la ligne de commande gardent le dernier mot : la configuration
 * fournit des défauts, elle n'impose rien.
 */

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { parseToml, TomlError } from "./toml.ts";

export interface Config {
  root?: string;
  tailnet?: string;
  tsTag?: string;
  /**
   * La cible par défaut de **cette machine**. C'est elle qui décide : DBox sur
   * le serveur travaille sur `prod`, DBox sur le poste sur `dev`. Le manifeste
   * reste le même des deux côtés.
   */
  target?: string;
  /** Où sont clonés les dépôts. Par défaut, le dossier parent de `root`. */
  sources?: string;
  /** Fichier contenant la clé d'auth, semée dans chaque nouvelle cible. */
  authkeyFile?: string;
  /**
   * Marqueur d'échéance pour la clé du daemon lui-même (`tag:dbox-admin`,
   * posée dans `deploy/ts.env`, jamais lue ici) — distincte de `authkeyFile`
   * qui sème les nouvelles apps. Seul `<fichier>.expires` compte.
   */
  adminAuthkeyFile?: string;
  /**
   * Token d'accès API Tailscale, pour `dbox rotate-authkey` — jamais lu par
   * le daemon. Volontairement absent des chemins que `serve` connaît.
   */
  apiTokenFile?: string;
  /**
   * Rapport des nœuds Tailscale abandonnés, écrit par `dbox rotate-authkey`,
   * lu par `serve` pour l'afficher sur /settings — jamais l'inverse.
   */
  orphansReportFile?: string;
  /**
   * Rapport de présence de `tsTag` dans `tagOwners`, écrit par
   * `dbox rotate-authkey`, lu par `serve` pour l'afficher sur /settings.
   */
  tagReportFile?: string;
  /**
   * Clé privée SSH dédiée aux clonages — jamais celle de la personne qui
   * installe DBox. `.pub` à côté est déduit, jamais renseigné séparément.
   */
  sshKeyFile?: string;
  /** Liste des autres machines DBox connues — gérée depuis l'interface, pas ici. */
  machinesFile?: string;
  /**
   * Racine des dossiers déjà présents sur la machine, déployables sans
   * clonage — typiquement là où vivent tes projets en cours d'édition.
   * Absente : « ajouter » depuis un dossier local reste indisponible, le
   * conteneur du daemon ne monte rien en dehors de `root`/`sources`.
   */
  workspacesRoot?: string;
}

const KEYS: Record<string, keyof Config> = {
  root: "root",
  tailnet: "tailnet",
  ts_tag: "tsTag",
  target: "target",
  sources: "sources",
  authkey_file: "authkeyFile",
  admin_authkey_file: "adminAuthkeyFile",
  api_token_file: "apiTokenFile",
  orphans_report_file: "orphansReportFile",
  tag_report_file: "tagReportFile",
  ssh_key_file: "sshKeyFile",
  machines_file: "machinesFile",
  workspaces_root: "workspacesRoot",
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env["DBOX_CONFIG"] !== undefined && env["DBOX_CONFIG"] !== "") return env["DBOX_CONFIG"];
  const base = env["XDG_CONFIG_HOME"] ?? `${env["HOME"] ?? homedir()}/.config`;
  return `${base}/dbox/config.toml`;
}

export function parseConfig(source: string): Config {
  const { data, lines } = parseToml(source);
  const config: Config = {};

  for (const [key, value] of Object.entries(data)) {
    const field = KEYS[key];
    if (field === undefined) {
      // Même règle que le manifeste : une clé mal orthographiée explose plutôt
      // que de disparaître en silence.
      throw new TomlError(
        `clé inconnue « ${key} » — attendu ${Object.keys(KEYS).join(", ")}`,
        lines.get(key) ?? 0,
      );
    }
    if (typeof value !== "string") {
      throw new TomlError(`« ${key} » doit être une chaîne`, lines.get(key) ?? 0);
    }
    config[field] = value;
  }

  return config;
}

const ORDER: (keyof Config)[] = [
  "root",
  "tailnet",
  "tsTag",
  "target",
  "sources",
  "authkeyFile",
  "adminAuthkeyFile",
  "apiTokenFile",
  "orphansReportFile",
  "tagReportFile",
  "sshKeyFile",
  "machinesFile",
  "workspacesRoot",
];
const KEY_NAMES = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v, k])) as Record<
  keyof Config,
  string
>;

/** L'inverse de `parseConfig` : sert à `dbox setup`, jamais à `dbox up`. */
export function serializeConfig(config: Config): string {
  const lines = ORDER.filter((field) => config[field] !== undefined).map(
    (field) => `${KEY_NAMES[field]} = "${config[field]}"`,
  );
  return lines.join("\n") + "\n";
}

/** Absente ou illisible : on se contente des défauts, sans rien dire. */
export async function loadConfig(path: string): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return {};
  }
  return parseConfig(source);
}
