/**
 * Ce que le daemon sait faire, au-delà de regarder.
 *
 * Chaque action se traduit par la commande qu'on taperait à la main. Rien
 * d'inventé, rien de caché : `docker compose start`, `stop`, `logs`, et pour le
 * redéploiement la même fonction `up()` que la ligne de commande.
 */

import type { Context } from "./compose.ts";
import { headscaleProbe, type Compose, type RunResult } from "./docker.ts";
import { parseEnv, serializeEnv, type EnvEntry } from "./env.ts";
import { httpProbe } from "./health.ts";
import { draft, nameFromDirectory, renderManifest, renderScaffold, targetNameFor, type NewTargetMode } from "./init.ts";
import { parseManifest, serializeManifest, type Manifest, type Target } from "./manifest.ts";
import { clone, isGitRepo, nameFromUrl, pull } from "./sources.ts";
import { resolveKeyFile } from "./sshkey.ts";
import { lireSiFichierOrdinaire } from "./lecture.ts";
import { SOUS_DOSSIERS_FRONT } from "./preflight.ts";
import { listDescriptors, type Entry } from "./registry.ts";
import { readState, writeState } from "./state.ts";
import { sourceTag } from "./tag.ts";
import { up, type UpResult } from "./up.ts";
import { seedAuthKey, writeFiles } from "./writer.ts";

export function startTarget(entry: Entry, compose: Compose): Promise<RunResult> {
  return compose(entry.directory, ["start"]);
}

export function stopTarget(entry: Entry, compose: Compose): Promise<RunResult> {
  return compose(entry.directory, ["stop"]);
}

/**
 * Un `restart`, pas un `stop` puis un `start` : c'est ce qu'on taperait, et
 * c'est le geste dont on a besoin quand un conteneur s'est mis de travers sans
 * que rien n'ait changé — inutile de reconstruire, inutile de redéployer.
 */
export function restartTarget(entry: Entry, compose: Compose): Promise<RunResult> {
  return compose(entry.directory, ["restart"]);
}

export async function logsOf(entry: Entry, compose: Compose, lines: number): Promise<string> {
  const result = await compose(entry.directory, ["logs", "--no-color", `--tail=${lines}`]);
  return result.stdout + result.stderr;
}

/**
 * Arrête la cible et supprime tout ce que DBox a généré pour elle — son
 * dossier sous `root` disparaît, donc l'entrée aussi : le système de
 * fichiers est le registre.
 *
 * Ne touche ni au dossier source (partagé par les autres cibles de la même
 * app, ou dossier de travail de la personne) ni aux volumes de données
 * nommés : `down` sans `--volumes`, comme un arrêt normal. Une donnée perdue
 * ne se récupère pas ; un dossier ou un volume oublié, si.
 *
 * Rien n'est supprimé si `down` échoue — même règle que le reste : un échec
 * ne touche à rien plutôt que de laisser un état à moitié détruit.
 */
export async function removeTarget(
  entry: Entry,
  compose: Compose,
  remove: (path: string) => Promise<void>,
): Promise<RunResult> {
  const result = await compose(entry.directory, ["down"]);
  if (result.code !== 0) return result;
  await remove(entry.directory);
  return result;
}

/**
 * Lit et écrit le `.env` d'une cible.
 *
 * Jamais `ts.env` : la clé d'authentification n'a pas à transiter par
 * l'interface, ni à s'afficher dans un navigateur. Le chemin est construit ici,
 * pas reçu de l'extérieur — aucune requête ne peut désigner un autre fichier.
 */
export async function readEnv(entry: Entry, read: (path: string) => Promise<string>): Promise<EnvEntry[]> {
  return parseEnv(await read(`${entry.directory}/.env`).catch(() => ""));
}

export async function writeEnv(
  entry: Entry,
  entries: EnvEntry[],
  write: (path: string, content: string) => Promise<void>,
): Promise<void> {
  await write(`${entry.directory}/.env`, serializeEnv(entries));
}

/**
 * Les fichiers que DBox a produits pour une cible, tels qu'ils sont sur le
 * disque. `doc/REFERENCE.md` fait une vertu de ce qu'ils soient lisibles —
 * encore faut-il pouvoir les lire sans ouvrir un shell sur la machine.
 *
 * **Liste blanche, jamais une liste noire** : les noms sont des constantes du
 * code, aucune requête ne peut en désigner un autre, et un fichier ajouté un
 * jour au plan reste invisible tant qu'on ne l'a pas inscrit ici — l'inverse
 * (tout montrer sauf…) aurait exposé le prochain fichier sensible par défaut.
 *
 * Deux absents délibérés : `ts.env`, qui porte la clé d'authentification et
 * n'a pas à s'afficher dans un navigateur (même raison que `readEnv`), et
 * `.env`, qui a son propre panneau avec les valeurs masquées — le montrer ici
 * contournerait ce masquage.
 *
 * L'ordre est celui de la lecture, pas celui du plan : le Compose d'abord,
 * c'est lui qu'on ouvre quand ça ne marche pas — le panneau déplie le premier.
 */
export const FICHIERS_MONTRABLES = ["docker-compose.yml", "serve.json", "dbox.json"];

export interface FichierMontre {
  name: string;
  content: string;
}

export async function readGeneratedFiles(
  entry: Entry,
  read: (path: string) => Promise<string>,
): Promise<FichierMontre[]> {
  const lus = await Promise.all(
    FICHIERS_MONTRABLES.map(async (name) => ({
      name,
      // Un fichier absent n'est pas une erreur : `serve.json` ne suit pas
      // forcément un plan d'une autre époque, et le panneau doit s'ouvrir
      // quand même sur ce qui existe.
      content: await read(`${entry.directory}/${name}`).catch(() => null),
    })),
  );
  return lus.filter((f): f is FichierMontre => f.content !== null);
}

/**
 * Applique la nouvelle configuration sans reconstruire : `up -d` recrée le
 * conteneur avec le nouveau fichier. L'image n'a pas changé, rien à construire.
 *
 * Une cible **à l'arrêt n'est pas démarrée** : enregistrer un réglage ne doit
 * pas remettre en marche ce qu'on avait délibérément coupé. Le fichier est
 * écrit, il sera lu au prochain démarrage.
 */
export async function applyEnv(entry: Entry, compose: Compose): Promise<RunResult | null> {
  if (entry.status !== "en marche" && entry.status !== "partielle") return null;
  return compose(entry.directory, ["up", "-d", "--no-build"]);
}

/** Les réglages de la cible tels qu'écrits dans `dbox.toml` — pas ceux déployés. */
export async function readManifestTarget(
  entry: Entry,
  read: (path: string) => Promise<string>,
): Promise<Target> {
  const manifest = parseManifest(await read(`${entry.descriptor.source}/dbox.toml`));
  const target = manifest.targets[entry.descriptor.target];
  if (target === undefined) {
    throw new Error(`cible « ${entry.descriptor.target} » absente de dbox.toml — le dépôt a-t-il changé ?`);
  }
  return target;
}

/**
 * Réécrit `dbox.toml` avec les changements fournis, pour cette cible
 * seulement — les autres cibles du même fichier restent inchangées.
 *
 * Le mode ne se change pas ici : passer de `workspace` à `deployed` change
 * la forme même du compose généré, une décision trop lourde pour un
 * formulaire. Le reste passe par un aller-retour texte — sérialiser, puis
 * reparser — pour profiter de la même validation que `dbox.toml` écrit à la
 * main, avec les mêmes messages d'erreur.
 *
 * N'applique jamais le changement : comme pour `.env`, enregistrer un
 * réglage n'a d'effet qu'au prochain déploiement, jamais tout de suite.
 */
export async function writeManifestTarget(
  entry: Entry,
  changes: Record<string, unknown>,
  read: (path: string) => Promise<string>,
  write: (path: string, content: string) => Promise<void>,
): Promise<Target> {
  const path = `${entry.descriptor.source}/dbox.toml`;
  const manifest = parseManifest(await read(path));
  const current = manifest.targets[entry.descriptor.target];
  if (current === undefined) {
    throw new Error(`cible « ${entry.descriptor.target} » absente de dbox.toml — le dépôt a-t-il changé ?`);
  }
  if ("mode" in changes && changes["mode"] !== current.mode) {
    throw new Error("le mode ne se change pas depuis ce panneau — édite dbox.toml directement");
  }

  manifest.targets[entry.descriptor.target] = { ...current, ...changes } as Target;
  const serialized = serializeManifest(manifest);
  const validated = parseManifest(serialized); // lève une ManifestError si invalide

  await write(path, serialized);
  return validated.targets[entry.descriptor.target]!;
}

export interface DeployOptions {
  ctx: Context;
  timeoutMs: number;
  authkeyFile?: string;
  /** Clé préauth Headscale — voir `UpOptions.headscaleAuthkeyFile`, jamais la même clé. */
  headscaleAuthkeyFile?: string;
  /** Image (celle du daemon) servant de conteneur-sonde pour une cible
   * headscale — voir `headscaleProbe`. Absente : pas de sonde headscale. */
  probeImage?: string;
  /** Clé SSH dédiée aux clonages — `undefined` : on retombe sur `~/.ssh`. */
  sshKeyFile?: string;
  readManifest: (path: string) => Promise<string>;
  /** Écrit un manifeste déduit, quand le dépôt n'en fournit pas. */
  writeManifest?: (path: string, content: string) => Promise<void>;
  /** Où sont clonés les dépôts. */
  sources?: string;
  /** Cible de cette machine — c'est elle qui décide, pas le manifeste. */
  defaultTarget?: string;
}

export type RedeployOptions = DeployOptions;

/**
 * Reconstruit et redéploie depuis les sources d'origine.
 *
 * Le manifeste est relu à chaque fois plutôt que mémorisé : c'est le fichier
 * dans le dépôt qui fait foi, et le `dbox.json` ne sert qu'à retrouver son
 * chemin.
 */
export async function redeploy(
  entry: Entry,
  compose: Compose,
  options: RedeployOptions,
  log: (line: string) => void,
): Promise<UpResult> {
  // Redéployer depuis l'interface veut dire « prends la dernière version ».
  // Sur un dépôt git, ça commence donc par tirer.
  if (await isGitRepo(entry.descriptor.source)) {
    // La clé dédiée de l'app prime si elle existe : elle a pu être générée
    // après coup, depuis sa carte, sans que rien d'autre n'ait besoin de le savoir.
    const sshKeyFile = await resolveKeyFile(options.sshKeyFile, entry.descriptor.app, { readFile: options.readManifest });
    const pulled = await pull(entry.descriptor.source, sshKeyFile);
    log(`  git pull · ${(pulled.stdout || pulled.stderr).trim().split("\n").pop() ?? ""}`);
  }
  return deployFrom(entry.descriptor.source, entry.descriptor.target, compose, options, log);
}

/**
 * Ce que choisit le formulaire d'ajout : le mode ne se devine pas, lui seul le
 * sait. En `workspace`/`devcontainer`, `port`/`command` viennent avec lui —
 * rien à lire pour ça, il n'y a pas encore de Dockerfile à interroger.
 */
export interface NewTargetChoice {
  mode: NewTargetMode;
  port: number;
  command?: string;
  /** `devcontainer` : image de l'environnement, quand Node ne convient pas. */
  image?: string;
  /** `devcontainer` : construire l'image du projet — prime sur `image`. */
  dockerfile?: string;
}

/**
 * Clone un dépôt, lui écrit un manifeste s'il n'en a pas, puis déploie.
 *
 * C'est « ajouter une app » : la seule chose qui demandait encore un shell sur
 * la machine.
 *
 * `deployed` reste deviné depuis le Dockerfile du dépôt une fois cloné —
 * c'est le seul mode qui s'y prête, `choice` n'a rien à y changer. Pour
 * `workspace`/`devcontainer`, le formulaire a déjà tout décidé et son
 * squelette (`renderScaffold`) remplace la déduction.
 */
export async function addApp(
  url: string,
  name: string | null,
  compose: Compose,
  options: DeployOptions,
  log: (line: string) => void,
  choice?: NewTargetChoice,
): Promise<UpResult> {
  if (options.sources === undefined || options.writeManifest === undefined) {
    throw new Error("ajout impossible : ni dossier de sources ni écriture configurés");
  }

  // Toujours passé par le même filtre que `nameFromUrl` applique déjà à un nom
  // déduit — un nom tapé à la main (« Nom (optionnel) ») n'a sinon aucune
  // raison d'être déjà un label DNS valide. Sans ça, le dossier cloné et la
  // clé SSH dédiée porteraient un nom que `ensureScaffold` en mode `deployed`
  // ne retrouve jamais (il redérive le nom depuis le dossier via `draft()`,
  // qui le normalise) — et en `workspace`/`devcontainer`, une majuscule ferait
  // simplement échouer la validation du manifeste.
  const appName = nameFromDirectory(name ?? nameFromUrl(url));
  const directory = `${options.sources}/${appName}`;
  if (await isGitRepo(directory)) {
    throw new Error(`${directory} est déjà un dépôt`);
  }

  // La clé machine ne peut être deploy key que sur un seul dépôt à la fois
  // (contrainte GitHub) — si une clé dédiée a déjà été générée pour ce nom
  // d'app (avant même le premier clonage, `POST /api/apps/:app/ssh-key` ne
  // dépend pas du registre), elle prime, comme pour `pull`.
  const sshKeyFile = await resolveKeyFile(options.sshKeyFile, appName, { readFile: options.readManifest });
  log(`clonage de ${url}`);
  const cloned = await clone(url, directory, sshKeyFile);
  if (cloned.code !== 0) throw new Error(cloned.stderr || cloned.stdout);

  await ensureScaffold(directory, appName, options, log, choice);
  return deployFrom(directory, choice === undefined ? null : targetNameFor(choice.mode), compose, options, log);
}

/**
 * Résout un chemin donné par le formulaire (relatif) sous la racine des
 * espaces de travail de cette machine — jamais un chemin absolu, jamais un
 * `..` : ni l'un ni l'autre ne donnerait accès à autre chose que ce que le
 * conteneur du daemon a déjà monté, mais un message clair vaut mieux qu'un
 * ENOENT incompréhensible trois fonctions plus loin.
 */
export function resolveWorkspacePath(root: string, relative: string): string {
  if (relative === "" || relative.startsWith("/") || relative.split("/").includes("..")) {
    throw new Error(`chemin invalide : « ${relative} » — un nom de dossier sous ${root}, sans « .. »`);
  }
  return `${root}/${relative}`;
}

/**
 * Les sous-dossiers de la racine des espaces de travail — de quoi choisir
 * dans une liste plutôt que taper un nom à l'aveugle. Absente ou illisible :
 * liste vide, jamais une erreur — un formulaire sans suggestion reste un
 * formulaire valide, on retombe simplement sur la saisie libre.
 */
export async function listWorkspaces(
  root: string,
  readdir: (path: string) => Promise<{ name: string; isDirectory: () => boolean }[]>,
  readFile: (path: string) => Promise<string>,
): Promise<{ name: string; command: string | null }[]> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map(async (name) => ({ name, command: await suggestedCommand(`${root}/${name}`, readFile) })));
}

/**
 * Un dossier local, contrairement à un dépôt tout juste cloné, est déjà là :
 * son `package.json` est lisible avant même que le formulaire soit soumis.
 * Absent, illisible, ou sans script `dev` : aucune suggestion, jamais une
 * erreur — même règle que `listWorkspaces` qui l'appelle. Une seule
 * convention reconnue (`npm run dev`) plutôt que deviner le gestionnaire de
 * paquets : une suggestion fausse serait pire qu'un champ vide, l'utilisateur
 * la corrige de toute façon en la tapant.
 */
async function suggestedCommand(directory: string, readFile: (path: string) => Promise<string>): Promise<string | null> {
  if (await aUnScriptDev(`${directory}/package.json`, readFile)) return "npm run dev";

  // Les sous-dossiers ne sont sondés **que si la racine n'a rien donné** : le
  // cas courant reste à une seule lecture, et `listWorkspaces` appelle cette
  // fonction pour chaque dossier de la racine des espaces de travail.
  for (const sous of SOUS_DOSSIERS_FRONT) {
    if (await aUnScriptDev(`${directory}/${sous}/package.json`, readFile)) {
      return `npm --prefix ${sous} run dev`;
    }
  }
  return null;
}

/** Absent, illisible, ou sans script `dev` : `false`, jamais une exception. */
async function aUnScriptDev(path: string, readFile: (path: string) => Promise<string>): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path)) as { scripts?: Record<string, string> };
    return pkg.scripts?.dev !== undefined;
  } catch {
    return false;
  }
}

/**
 * Déploie un dossier déjà présent sur la machine — jamais cloné, jamais créé
 * par DBox. Le pendant de `addApp` pour un projet déjà en cours d'édition :
 * pas d'URL à donner, juste un chemin déjà accessible au daemon.
 *
 * `directory` doit être résolu et validé par l'appelant (rester sous la
 * racine des espaces de travail configurée) — cette fonction n'en sait rien,
 * elle échoue simplement si le dossier n'est pas accessible.
 */
export async function addLocalApp(
  directory: string,
  compose: Compose,
  options: DeployOptions,
  log: (line: string) => void,
  choice?: NewTargetChoice,
): Promise<UpResult> {
  if (options.writeManifest === undefined) {
    throw new Error("ajout impossible : écriture non configurée");
  }

  await ensureScaffold(directory, nameFromDirectory(directory), options, log, choice);
  return deployFrom(directory, choice === undefined ? null : targetNameFor(choice.mode), compose, options, log);
}

/**
 * Ce que l'ajout écrira comme `dbox.toml`, montré **avant** de cliquer.
 *
 * Même décision que `ensureScaffold`, en lecture seule : un manifeste déjà là
 * gagne toujours ; sinon le squelette du formulaire (`workspace` et
 * `devcontainer`) ou la déduction depuis le Dockerfile (`deployed`). Pour un
 * dépôt pas encore cloné, il n'y a rien à lire : l'aperçu le dit au lieu
 * d'inventer un port.
 */
export interface Apercu {
  contenu: string | null;
  note: string;
}

export async function apercuManifeste(
  demande: { source: "git" | "local"; url: string; name: string | null; dossier: string | null },
  choice: NewTargetChoice | undefined,
  readFile: (path: string) => Promise<string>,
): Promise<Apercu> {
  if (demande.source === "local") {
    if (demande.dossier === null) return { contenu: null, note: "choisis un dossier" };
    const existant = await readFile(`${demande.dossier}/dbox.toml`).catch(() => null);
    if (existant !== null) {
      return { contenu: existant, note: "ce dossier a déjà un dbox.toml : il est utilisé tel quel, le formulaire n'y change rien" };
    }
    const nom = nameFromDirectory(demande.dossier);
    if (choice !== undefined && choice.mode !== "deployed") {
      return { contenu: renderScaffold({ name: nom, ...choice }), note: "écrit dans le dossier au moment de l'ajout" };
    }
    const dockerfile = await readFile(`${demande.dossier}/Dockerfile`).catch(() => null);
    if (dockerfile === null) {
      return { contenu: null, note: "pas de Dockerfile dans ce dossier : le mode prod en a besoin pour construire l'image" };
    }
    return {
      contenu: renderManifest(draft(demande.dossier, dockerfile), !/^EXPOSE\s/im.test(dockerfile)),
      note: "déduit du Dockerfile du dossier",
    };
  }

  if (demande.url === "") return { contenu: null, note: "colle l'adresse du dépôt" };
  const nom = nameFromDirectory(demande.name ?? nameFromUrl(demande.url));
  if (choice !== undefined && choice.mode !== "deployed") {
    return {
      contenu: renderScaffold({ name: nom, ...choice }),
      note: "sauf si le dépôt a déjà son propre dbox.toml — il serait alors utilisé tel quel",
    };
  }
  return {
    contenu: null,
    note: `mode prod : le manifeste de « ${nom} » sera déduit du Dockerfile du dépôt après clonage (port d'EXPOSE, volume de VOLUME) — ou repris tel quel si le dépôt en a déjà un`,
  };
}

/**
 * Écrit un manifeste dans `directory` s'il n'en a pas déjà un — jamais s'il en
 * a un, même invalide. Partagé entre le clonage git et un dossier déjà
 * présent : la déduction ne dépend pas de la provenance des fichiers.
 */
async function ensureScaffold(
  directory: string,
  appName: string,
  options: DeployOptions,
  log: (line: string) => void,
  choice?: NewTargetChoice,
): Promise<void> {
  const existing = await options.readManifest(`${directory}/dbox.toml`).catch(() => null);
  if (existing !== null) return;

  log("aucun dbox.toml : j'en écris un");
  if (choice !== undefined && choice.mode !== "deployed") {
    await options.writeManifest!(`${directory}/dbox.toml`, renderScaffold({ name: appName, ...choice }));
    log(`  nom ${appName} · mode ${choice.mode} · port ${choice.port}`);
  } else {
    const dockerfile = await options.readManifest(`${directory}/Dockerfile`).catch(() => null);
    const proposal = draft(directory, dockerfile);
    await options.writeManifest!(
      `${directory}/dbox.toml`,
      renderManifest(proposal, dockerfile === null || !/^EXPOSE\s/im.test(dockerfile)),
    );
    log(`  nom ${proposal.name} · port ${proposal.port}`);
  }
}

async function deployFrom(
  source: string,
  target: string | null,
  compose: Compose,
  options: DeployOptions,
  log: (line: string) => void,
): Promise<UpResult> {
  const manifest = parseManifest(await options.readManifest(`${source}/dbox.toml`));
  const chosen = target ?? chooseTarget(manifest, options.defaultTarget);
  const tag = await sourceTag(source);

  return up(
    {
      manifest,
      target: chosen,
      ctx: { ...options.ctx, sourcePath: source },
      tag,
      authkeyFile: options.authkeyFile,
      headscaleAuthkeyFile: options.headscaleAuthkeyFile,
      healthTimeoutMs: options.timeoutMs,
    },
    {
      compose,
      probe: httpProbe,
      headscaleProbe:
        options.probeImage === undefined ? undefined : (project) => headscaleProbe(project, options.probeImage!),
      writeFiles,
      seedAuthKey,
      readState,
      writeState,
      // Pas le lecteur injecté habituel : un fichier du projet peut être un tube
      // nommé qui bloquerait le déploiement pour toujours (voir `lecture.ts`).
      readSource: lireSiFichierOrdinaire,
      listDescriptors: () => listDescriptors(options.ctx.root),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: Date.now,
      log,
    },
  );
}

/** La machine décide de la cible ; le manifeste ne fait que les déclarer. */
function chooseTarget(manifest: Manifest, configured: string | undefined): string {
  const names = Object.keys(manifest.targets);
  if (configured !== undefined && names.includes(configured)) return configured;
  if (names.includes("prod")) return "prod";
  if (names.length === 1) return names[0]!;
  throw new Error(`plusieurs cibles (${names.join(", ")}) et aucune réglée sur cette machine`);
}
