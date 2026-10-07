#!/usr/bin/env node
/**
 * `dbox plan` affiche ce que DBox écrirait, sans rien toucher.
 * `dbox up`   écrit, construit, démarre, vérifie, et revient en arrière si besoin.
 */

import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { configPath, loadConfig, serializeConfig, type Config } from "./config.ts";
import { draft, renderManifest } from "./init.ts";
import { checkUpstream, clone, isGitRepo, nameFromUrl, pull } from "./sources.ts";
import { DEFAULT_CONTEXT, type Context, type TraefikConfig } from "./compose.ts";
import { hostname } from "node:os";
import { composeRunner, headscaleProbe, run } from "./docker.ts";
import { avecCache, versionInfo } from "./versions.ts";
import { versionAffichee, versionDuPaquet } from "./version.ts";
import { aDesBloquants, diagnostic, formaterTexte } from "./doctor.ts";
import { effetsReels } from "./doctor-reel.ts";
import { httpProbe, pinnedHttpProbe } from "./health.ts";
import { ManifestError, parseManifest, type Manifest } from "./manifest.ts";
import { planFor, type Plan } from "./plan.ts";
import { listDescriptors, PS_ARGS, scan, since, type Entry } from "./registry.ts";
import { addApp, addLocalApp, listWorkspaces, redeploy, removeTarget, resolveWorkspacePath } from "./actions.ts";
import { readAuthkeyNotice } from "./authkey.ts";
import { certExpiryFromPem, certNotice, readCertExpiry, type CertNotice } from "./cert.ts";
import { lireSiFichierOrdinaire } from "./lecture.ts";
import { Jobs } from "./jobs.ts";
import { startPolling } from "./poller.ts";
import { checkOrphansOnce, STALE_AFTER_DAYS, startCheckingOrphans } from "./orphans.ts";
import { readOrphansReport } from "./orphans-report.ts";
import { checkTagOnce, startCheckingTag } from "./tagcheck.ts";
import { readTagReport } from "./tag-report.ts";
import { rotateHeadscaleOnce, rotateOnce, startRotating, startRotatingHeadscale } from "./rotate.ts";
import { createServer } from "./server.ts";
import { readState, writeState } from "./state.ts";
import { appKeyFile, ensureKey, keyPaths, readPublicKey, resolveKeyFile } from "./sshkey.ts";
import { readMachines, writeMachines } from "./machines.ts";
import { createAuthKey, listDevices, listTagOwners, revokeAuthKey } from "./tailscale.ts";
import { createPreAuthKey, expirePreAuthKey } from "./headscale.ts";
import { sourceTag } from "./tag.ts";
import { TomlError } from "./toml.ts";
import { up } from "./up.ts";
import { seedAuthKey, writeFiles } from "./writer.ts";

const USAGE = `dbox <setup|add|init|plan|up|rm|ls|serve|rotate-authkey> [dossier|url|app] [options]

  --version         la version de cette copie de DBox
  setup             configure cette machine une fois pour toutes (interactif)
  doctor            vérifie les prérequis de cette machine, sans rien modifier
  add <url>         clone un dépôt, écrit son manifeste au besoin, et déploie
  init              écrit un dbox.toml à partir du dossier et de son Dockerfile
  plan              affiche les fichiers générés, sans rien toucher
  up                déploie : construit, démarre, vérifie, revient en arrière si échec
  rm <app>          arrête et supprime une cible déployée ; source et volumes intacts
  ls                inventaire des cibles déployées et de leur état
  serve             daemon HTTP : la même liste, dans un navigateur (lecture seule)
  rotate-authkey    régénère --authkey-file via l'API Tailscale si l'échéance approche
                    (jamais depuis le daemon — voir deploy/docker-compose.yml)

  --target <nom>    cible à traiter (défaut : « prod », ou l'unique cible)
  --yes             (rm) ne pas demander confirmation
  --write           (plan) écrit les fichiers au lieu de seulement les afficher
  --root <chemin>   racine des fichiers générés (défaut ${DEFAULT_CONTEXT.root})
  --tailnet <nom>   domaine du tailnet (défaut $DBOX_TAILNET)
  --tag <tag>       version à déployer (défaut : le SHA git des sources)
  --ts-tag <tag>    tag ACL des nœuds (défaut ${DEFAULT_CONTEXT.tsTag}) ; vide pour n'en annoncer aucun
  --backend <nom>   backend d'exposition par défaut : tailscale ou headscale (défaut tailscale)
  --headscale-login-server <url>   URL du serveur Headscale (--login-server du sidecar)
  --headscale-cert-dir <chemin>    dossier hôte du certificat wildcard <tailnet>.crt/.key
  --headscale-authkey-file <f>     clé préauth Headscale, semée dans les cibles headscale
  --probe-image <ref>              image (celle du daemon) pour sonder la santé d'une cible headscale
  --traefik-network <nom>        réseau Docker externe du Traefik de cette machine (mode public)
  --traefik-cert-resolver <nom>  resolver ACME de ce Traefik (mode public)
  --timeout <s>     délai du contrôle de santé (défaut 180)
  --port <n>        (serve) port d'écoute (défaut 8099)
  --host <adresse>  (serve) interface d'écoute (défaut 0.0.0.0)
  --poll-interval <s>  (serve) sondage des cibles auto_deploy (défaut 300 ; 0 = désactivé)
  --allowed-users <csv> (serve) identités Tailscale autorisées (ex. moi@github) ;
                    vide = toute identité du tailnet passe (ACL Tailscale seule)
  --authkey-file <f> clé d'auth semée dans chaque nouvelle cible
  --admin-authkey-file <f> (serve) marqueur d'échéance de la clé du daemon (défaut : à côté de --authkey-file)
  --api-token-file <f> (rotate-authkey) token d'accès API Tailscale (défaut : à côté de --authkey-file)
  --headscale-api-token-file <f>  (rotate-authkey) token d'API Headscale, pour la rotation de sa clé préauth
  --headscale-user <id>           (rotate-authkey) ID NUMÉRIQUE du user Headscale (ex. 1 ; pas son nom)
  --orphans-report-file <f> rapport des nœuds abandonnés, écrit par rotate-authkey, lu par serve (défaut : à côté de --authkey-file)
  --tag-report-file <f> rapport de présence de --ts-tag dans tagOwners, écrit par rotate-authkey, lu par serve (défaut : à côté de --authkey-file)
  --interval <s>    (rotate-authkey) tourne en continu à cet intervalle, au lieu d'une passe unique
  --ssh-key-file <f> clé SSH dédiée aux clonages (défaut : ~/.ssh de l'hôte)
  --machines-file <f> (serve) autres machines DBox connues, gérées depuis l'interface
  --workspaces-root <chemin> (serve) racine des dossiers locaux déployables sans clonage
  --sources <chemin> où sont clonés les dépôts (défaut : parent de --root)
  --name <nom>      (add) nom de l'app, sinon déduit de l'URL
  --pull            (up) tirer le dépôt avant de déployer

Les valeurs par défaut se posent une fois pour toutes dans ${configPath()} :

  root = "/home/toi/dbox/apps"
  tailnet = "mon-tailnet.ts.net"
  ts_tag = "tag:dbox"
  authkey_file = "/home/toi/dbox/authkey"
`;

interface Options {
  directory: string;
  target?: string;
  write: boolean;
  root: string;
  tailnet: string;
  tag?: string;
  tsTag: string | null;
  /** Backend d'exposition par défaut de la machine ("tailscale"/"headscale"). */
  backend: string;
  headscaleLoginServer?: string;
  headscaleCertDir?: string;
  headscaleAuthkeyFile?: string;
  headscaleApiTokenFile?: string;
  headscaleUser?: string;
  /** Image (celle du daemon) servant à sonder une cible headscale depuis le
   * netns de son sidecar — voir `headscaleProbe`. Absente : pas de sonde
   * headscale, donc on retombe sur le DNS public (qui échoue). */
  probeImage?: string;
  /** Les deux se posent ensemble ou pas du tout — sans eux, une cible qui
   * demande `public_domain` est refusée, jamais routée vers un Traefik deviné. */
  traefikNetwork?: string;
  traefikCertResolver?: string;
  timeoutMs: number;
  port: number;
  host: string;
  /** 0 = pas de sondage : aucune cible n'est jamais redéployée sans qu'on le demande. */
  pollIntervalMs: number;
  authkeyFile?: string;
  /** Marqueur d'échéance pour la clé du daemon lui-même (`tag:dbox-admin`,
   * `deploy/ts.env`) — jamais lu autrement que `<fichier>.expires`, comme
   * `authkeyFile`. `undefined` : pas de bannière pour cette clé-là. */
  adminAuthkeyFile?: string;
  /** (rotate-authkey) token d'accès API Tailscale — jamais lu par le daemon,
   * seulement par cette commande, volontairement tenue à l'écart. */
  apiTokenFile?: string;
  /** Écrit par `rotate-authkey` (nœuds Tailscale abandonnés), lu par `serve`
   * pour l'afficher sur /settings — jamais l'inverse, jamais un appel API
   * depuis le daemon. Partagé par le montage `$DBOX_HOME` des deux conteneurs. */
  orphansReportFile?: string;
  /** Même principe, pour la présence de `--ts-tag` dans `tagOwners` — voir
   * `tagcheck.ts`. */
  tagReportFile?: string;
  /** (rotate-authkey) `undefined` : une seule passe puis sortie ; sinon,
   * tourne en continu à cet intervalle — pensé pour un conteneur dédié qui
   * ne s'arrête jamais, comme `serve`. */
  rotateIntervalMs?: number;
  /** `undefined` : les clonages retombent sur `~/.ssh` tel qu'il est monté. */
  sshKeyFile?: string;
  /** `undefined` : le sélecteur de machines reste absent de la page. */
  machinesFile?: string;
  /** `undefined` : « ajouter » ne propose pas de dossier local, seulement un dépôt git. */
  workspacesRoot?: string;
  /** Cible par défaut de la machine, lue dans la configuration. */
  defaultTarget?: string;
  /** (serve) identités Tailscale autorisées. Vide : toute identité du tailnet
   * passe (l'ACL Tailscale reste la seule frontière). */
  allowedUsers?: string[];
  sources: string;
  name?: string;
  pull: boolean;
  /** (rm) sauter la confirmation interactive — pour un script. */
  yes: boolean;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`dbox ${versionAffichee(process.env["DBOX_VERSION"], versionDuPaquet())}\n`);
    return 0;
  }
  // Commande cachée : la sonde de santé d'une cible headscale. Lancée dans le
  // netns du sidecar de la cible (voir `headscaleProbe`), elle interroge Caddy
  // sur 127.0.0.1 avec le nom en SNI. Hors USAGE : ce n'est pas une commande
  // destinée à être tapée à la main, juste le point d'entrée du conteneur-sonde.
  if (command === "__probe") {
    const status = await pinnedHttpProbe("127.0.0.1")(argv[1] ?? "");
    process.stdout.write(status === null ? "null" : String(status));
    return status === null ? 1 : 0;
  }
  // Commande cachée jumelle : la date d'expiration du certificat wildcard
  // headscale. Lancée dans un conteneur root qui monte le dossier (le daemon,
  // 1000:1000, ne peut pas lire un 0600 root) — voir `readCertExpiry`.
  if (command === "__certexpiry") {
    const pem = await readFile(argv[1] ?? "", "utf8").catch(() => null);
    const iso = pem === null ? null : certExpiryFromPem(pem);
    process.stdout.write(iso ?? "null");
    return iso === null ? 1 : 0;
  }
  if (!["setup", "doctor", "add", "init", "plan", "up", "rm", "ls", "serve", "rotate-authkey"].includes(command)) {
    process.stderr.write(`commande inconnue « ${command} »\n\n${USAGE}`);
    return 1;
  }

  // Ni manifeste, ni configuration à charger : c'est justement elle qu'on écrit.
  if (command === "setup") return await runSetup();

  const config = await loadConfig(configPath());
  const options = parseArgs(argv.slice(1), config);

  // Avant tout refus : le diagnostic doit tourner justement quand la
  // configuration est incomplète, c'est lui qui le dit.
  if (command === "doctor") return await runDoctor(options);

  if (command === "init") return await runInit(resolve(options.directory));

  // Mieux vaut refuser que produire une URL fausse : un tailnet non renseigné
  // se retrouverait dans le dbox.json, dans le contrôle de santé et dans la
  // page — trois endroits où l'erreur est difficile à rattacher à sa cause.
  // `add` déploie, donc il est concerné lui aussi. `rm` ne construit aucune
  // URL — il n'interroge que le registre existant.
  if (command !== "ls" && command !== "rm" && options.tailnet.includes("<")) {
    process.stderr.write(
      "tailnet inconnu : précise --tailnet <nom>.ts.net ou pose $DBOX_TAILNET\n",
    );
    return 1;
  }

  // Un seul des deux posé est une faute de saisie, à signaler tout de suite
  // plutôt qu'un « traefik non configuré » vague au premier déploiement public.
  if (
    command !== "ls" &&
    command !== "rm" &&
    (options.traefikNetwork === undefined) !== (options.traefikCertResolver === undefined)
  ) {
    process.stderr.write("--traefik-network et --traefik-cert-resolver se posent ensemble, ou pas du tout\n");
    return 1;
  }

  if (command === "add") return await runAdd(options);

  // `ls`, `rm` et `serve` interrogent le registre : ni manifeste ni dossier source.
  if (command === "ls") return await runLs(options);
  if (command === "rm") return await runRm(options);
  if (command === "serve") return await runServe(options);
  if (command === "rotate-authkey") return await runRotateAuthkey(options);

  const directory = resolve(options.directory);

  // `up` amorce lui-même le manifeste s'il manque — comme `add` le fait déjà
  // pour un dépôt fraîchement cloné. `plan` n'y touche jamais : il promet de
  // n'écrire rien, "afficher... sans rien toucher".
  if (command === "up") {
    const failure = await ensureManifest(directory);
    if (failure !== null) return failure;
  }

  const manifest = await loadManifest(directory);
  if (manifest === null) return 1;

  const ctx = contextFor(options, directory);

  return command === "plan"
    ? await runPlan(manifest, ctx, options)
    : await runUp(manifest, ctx, options, directory);
}

/**
 * Écrit un manifeste s'il n'existe pas déjà — jamais s'il existe, même
 * invalide : un manifeste mal formé doit être corrigé, pas remplacé en
 * silence par une proposition devinée.
 */
async function ensureManifest(directory: string): Promise<number | null> {
  const path = `${directory}/dbox.toml`;
  const exists = await readFile(path, "utf8").then(() => true).catch(() => false);
  if (exists) return null;

  process.stdout.write("aucun dbox.toml : j'en écris un\n");
  const written = await runInit(directory);
  return written === 0 ? null : written;
}

/** Le chemin de `up` quand le dossier n'est pas celui passé en argument. */
async function runUpAt(directory: string, options: Options): Promise<number> {
  const manifest = await loadManifest(directory);
  if (manifest === null) return 1;
  return await runUp(manifest, contextFor(options, directory), options, directory);
}

/** Les deux réglages se posent ensemble ou pas du tout — vérifié dans `main`. */
function traefikConfigFor(options: Options): TraefikConfig | null {
  if (options.traefikNetwork === undefined || options.traefikCertResolver === undefined) return null;
  return { network: options.traefikNetwork, certResolver: options.traefikCertResolver };
}

/** Backend résolu + réglages headscale pour le Context — les deux réglages
 * headscale se posent ensemble ou pas du tout (sinon « headscale » est un
 * refus, jamais un défaut deviné), exactement comme les deux réglages Traefik. */
function backendCtxFor(options: Options): Pick<Context, "backend" | "headscale"> {
  // Validé ici, pas seulement au parse de `--backend` : `backend` peut aussi
  // venir de `config.toml`, qui n'a pas de contrôle d'énumération. Sans ça, un
  // `backend = "headscal"` mal tapé retomberait en silence sur tailscale —
  // l'app sortirait par le mauvais backend sans un mot (esprit de l'invariant 15).
  if (options.backend !== "tailscale" && options.backend !== "headscale") {
    throw new Error(`backend inconnu « ${options.backend} » — attendu « tailscale » ou « headscale »`);
  }
  const backend = options.backend;
  const headscale =
    options.headscaleLoginServer === undefined || options.headscaleCertDir === undefined
      ? null
      : { loginServer: options.headscaleLoginServer, certDir: options.headscaleCertDir };
  return { backend, headscale };
}

/** Met en cache le résultat d'une lecture coûteuse pendant `ttlMs` — la lecture
 * du certificat passe par un conteneur, inutile de la refaire à chaque
 * affichage de /settings alors que la date bouge sur des mois. */
function cacheExpiration(lire: () => Promise<string | null>, ttlMs: number): () => Promise<string | null> {
  let jamais = true;
  let echeance = 0;
  let valeur: string | null = null;
  return async () => {
    const maintenant = Date.now();
    if (!jamais && maintenant < echeance) return valeur;
    valeur = await lire().catch(() => null);
    echeance = maintenant + ttlMs;
    jamais = false;
    return valeur;
  };
}

function contextFor(options: Options, directory: string): Context {
  return {
    ...DEFAULT_CONTEXT,
    root: options.root,
    tailnet: options.tailnet,
    tsTag: options.tsTag,
    traefik: traefikConfigFor(options),
    ...backendCtxFor(options),
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    sourcePath: directory,
  };
}

async function loadManifest(directory: string): Promise<Manifest | null> {
  const path = `${directory}/dbox.toml`;
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    process.stderr.write(`aucun dbox.toml dans ${directory}\n`);
    return null;
  }

  try {
    return parseManifest(source);
  } catch (error) {
    if (error instanceof TomlError || error instanceof ManifestError) {
      process.stderr.write(`${path}\n  ${error.message}\n`);
      return null;
    }
    throw error;
  }
}

async function runPlan(manifest: Manifest, ctx: Context, options: Options): Promise<number> {
  const targets = options.target === undefined ? Object.keys(manifest.targets) : [options.target];

  for (const target of targets) {
    // La version déjà déployée fait foi : régénérer le compose ne doit pas y
    // écrire un tag d'image qui n'existe pas, sans quoi le prochain démarrage
    // tenterait de reconstruire — voire de télécharger — au lieu de repartir.
    const deployed = await readState(`${ctx.root}/${manifest.name}/${target}`);
    const imageTag = options.tag ?? deployed?.tag ?? DEFAULT_CONTEXT.imageTag;
    const plan = planFor(manifest, target, { ...ctx, imageTag });

    process.stdout.write(render(plan));
    if (options.write) {
      const outcomes = await writeFiles(plan.files);
      for (const outcome of outcomes) {
        process.stdout.write(`${outcome.written ? "écrit    " : "préservé "} ${outcome.path}\n`);
      }
      const seeded = await seedAuthKey(outcomes, options.authkeyFile);
      if (seeded !== null) process.stdout.write(`clé posée ${seeded}\n`);
      process.stdout.write("\n");
    }
  }

  return 0;
}

async function runUp(
  manifest: Manifest,
  ctx: Context,
  options: Options,
  directory: string,
): Promise<number> {
  const target = options.target ?? defaultTarget(manifest, options.defaultTarget);

  if (options.pull && (await isGitRepo(directory))) {
    const pulled = await pull(directory, options.sshKeyFile);
    process.stdout.write(`${(pulled.stdout || pulled.stderr).trim()}\n`);
    if (pulled.code !== 0) return 1;
  }

  const tag = options.tag ?? (await sourceTag(directory));
  const log = (line: string) => process.stdout.write(`${line}\n`);

  const result = await up(
    {
      manifest,
      target,
      ctx,
      tag,
      healthTimeoutMs: options.timeoutMs,
      authkeyFile: options.authkeyFile,
      headscaleAuthkeyFile: options.headscaleAuthkeyFile,
    },
    {
      compose: composeRunner((line) => {
        if (line.trim() !== "") log(`  │ ${line}`);
      }),
      probe: httpProbe,
      headscaleProbe:
        options.probeImage === undefined ? undefined : (project) => headscaleProbe(project, options.probeImage!),
      writeFiles,
      seedAuthKey,
      readState,
      writeState,
      listDescriptors: () => listDescriptors(ctx.root),
      readSource: lireSiFichierOrdinaire,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: Date.now,
      log,
    },
  );

  if (result.ok) return 0;

  log("");
  log(`échec : ${result.failure}`);
  if (result.detail !== null) log(result.detail.replace(/^/gm, "  "));
  if (result.failure === "construction" || result.failure === "domaine") {
    log("la version en place n'a pas été touchée.");
  } else if (result.rolledBackTo !== null) {
    log(`retour effectué sur ${result.rolledBackTo}.`);
  }
  if (result.failure === "santé") {
    // Neuf fois sur dix c'est le sidecar qui n'a pas rejoint le tailnet, et la
    // raison est dans ses journaux — pas dans ceux de l'app.
    log("");
    log(`journaux du sidecar : docker logs ${result.plan.project}-tailscale-1`);
  }
  return 1;
}

/**
 * Cloner puis déployer, en une commande.
 *
 * Le dépôt est cloné sous `sources`, à côté des autres — pas dans un dossier
 * caché : il reste consultable, et `git pull` y fonctionne comme partout.
 */
async function runAdd(options: Options): Promise<number> {
  const url = options.directory;
  if (url === ".") {
    process.stderr.write("dbox add attend une URL de dépôt\n");
    return 1;
  }

  const name = options.name ?? nameFromUrl(url);
  const directory = `${options.sources}/${name}`;

  if (await readFile(`${directory}/.git/HEAD`, "utf8").then(() => true).catch(() => false)) {
    process.stderr.write(`${directory} est déjà un dépôt — utilise « dbox up ${directory} --pull »\n`);
    return 1;
  }

  process.stdout.write(`clonage de ${url}\n  vers ${directory}\n`);
  const cloned = await clone(url, directory, options.sshKeyFile);
  if (cloned.code !== 0) {
    process.stderr.write(`${cloned.stderr || cloned.stdout}`);
    return 1;
  }

  const failure = await ensureManifest(directory);
  if (failure !== null) return failure;

  return await runUpAt(directory, options);
}

/**
 * Configure la machine une fois pour toutes : `~/.config/dbox/config.toml`.
 *
 * N'écrit jamais la clé Tailscale elle-même — seulement où DBox doit aller la
 * chercher. Le geste de la poser reste manuel, en dehors de tout prompt : c'est
 * ce qui garantit qu'un secret ne transite jamais par un outil qui pourrait le
 * journaliser.
 */
async function runSetup(): Promise<number> {
  const path = configPath();

  if (await readFile(path, "utf8").then(() => true).catch(() => false)) {
    process.stderr.write(`${path} existe déjà — rien touché. Édite-le à la main si besoin.\n`);
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback: string): Promise<string> => {
    const answer = (await rl.question(`${question} [${fallback}] `)).trim();
    return answer === "" ? fallback : answer;
  };

  process.stdout.write(`Configuration de cette machine — ${path}\n\n`);

  const home = process.env["HOME"] ?? "/root";
  let config: Config;
  try {
    const tailnet = await ask("Domaine du tailnet (ex. mon-tailnet.ts.net)", "");
    if (tailnet === "") {
      process.stderr.write("le tailnet est obligatoire : sans lui, DBox ne peut construire aucune URL\n");
      return 1;
    }
    const target = await ask("Cible que gère cette machine (prod / dev / …)", "prod");
    const root = await ask("Racine des fichiers générés", `${home}/dbox/apps`);
    const tsTag = await ask("Tag ACL des nœuds créés", "tag:dbox");
    const authkeyFile = await ask("Fichier de la clé Tailscale (contenu à poser toi-même)", `${home}/dbox/authkey`);
    config = { tailnet, target, root, tsTag, authkeyFile };
  } finally {
    rl.close();
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeConfig(config));

  process.stdout.write(`\nécrit ${path}\n\n`);
  process.stdout.write("Il reste une chose à faire à la main — jamais par un outil, jamais collée ici :\n");
  process.stdout.write(`  mkdir -p ${dirname(config.authkeyFile!)}\n`);
  process.stdout.write(`  echo 'tskey-auth-…' > ${config.authkeyFile}\n`);
  process.stdout.write("\nPuis : dbox init <dossier> && dbox up <dossier>\n");
  return 0;
}

async function runInit(directory: string): Promise<number> {
  const manifestPath = `${directory}/dbox.toml`;
  try {
    await readFile(manifestPath, "utf8");
    process.stderr.write(`${manifestPath} existe déjà — rien touché\n`);
    return 1;
  } catch {
    // Absent : c'est le cas attendu.
  }

  const dockerfile = await readFile(`${directory}/Dockerfile`, "utf8").catch(() => null);
  const proposal = draft(directory, dockerfile);
  const guessed = dockerfile === null || !/^EXPOSE\s/im.test(dockerfile);

  await writeFile(manifestPath, renderManifest(proposal, guessed));

  process.stdout.write(`écrit ${manifestPath}\n`);
  process.stdout.write(`  nom    ${proposal.name}\n`);
  process.stdout.write(`  port   ${proposal.port}${guessed ? "   (deviné — à vérifier)" : "   (depuis EXPOSE)"}\n`);
  if (proposal.data !== null) process.stdout.write(`  data   ${proposal.data}   (depuis VOLUME)\n`);
  if (dockerfile === null) process.stdout.write("  aucun Dockerfile : il reste à écrire, DBox ne le devine pas\n");
  return 0;
}

async function runDoctor(options: Options): Promise<number> {
  const configPresente = await readFile(configPath(), "utf8").then(
    () => true,
    () => false,
  );
  const tailnet = options.tailnet.includes("<") ? undefined : options.tailnet;
  // La CLI, lancée par la personne, peut lire le token d'API pour vérifier le
  // tag en direct quand le rapport du rotator manque. Le daemon, jamais.
  const tokenFile = options.apiTokenFile;
  const tagOwners =
    tokenFile === undefined || tailnet === undefined
      ? undefined
      : async () => {
          const token = (await readFile(tokenFile, "utf8").catch(() => "")).trim();
          return token === "" ? null : await listTagOwners(tailnet, token);
        };
  const tagFile = options.tagReportFile;

  process.stdout.write(`dbox doctor — ${hostname()}\n\n`);
  const constats = await diagnostic({
    ...effetsReels(options.root),
    tailnet,
    tsTag: options.tsTag,
    root: options.root,
    authkeyFile: options.authkeyFile,
    configPresente,
    backend: options.backend,
    headscaleLoginServer: options.headscaleLoginServer,
    headscaleCertDir: options.headscaleCertDir,
    headscaleAuthkeyFile: options.headscaleAuthkeyFile,
    // Lecture directe (pas de daemon à ménager ici) : un conteneur root lit le
    // certificat, à condition que le backend soit headscale et l'image posée.
    certExpiry:
      options.backend === "headscale" && options.headscaleCertDir !== undefined && options.probeImage !== undefined && tailnet !== undefined
        ? () => readCertExpiry(options.headscaleCertDir!, tailnet, options.probeImage!)
        : undefined,
    tagReport: tagFile === undefined ? async () => null : () => readTagReport(tagFile, (p) => readFile(p, "utf8")),
    tagOwners,
  });
  process.stdout.write(formaterTexte(constats));
  return aDesBloquants(constats) ? 1 : 0;
}

async function runLs(options: Options): Promise<number> {
  const entries = await scan(options.root, async () => (await run("docker", PS_ARGS)).stdout);

  if (entries.length === 0) {
    process.stdout.write(`aucune cible dans ${options.root}\n`);
    return 0;
  }

  process.stdout.write(renderTable(entries, Date.now()));
  return 0;
}

/**
 * Arrête et supprime une cible déjà déployée — jamais son dossier source, ni
 * ses volumes de données nommés (`removeTarget`, voir son commentaire). Le
 * pendant de `add` : ce que le tableau de bord fait en un clic derrière une
 * confirmation, cette commande le fait derrière une autre, ou `--yes` pour un
 * script.
 */
async function runRm(options: Options): Promise<number> {
  const appName = options.directory;
  if (appName === ".") {
    process.stderr.write("dbox rm attend un nom d'app\n");
    return 1;
  }

  const entries = await scan(options.root, async () => (await run("docker", PS_ARGS)).stdout);
  const matches = entries.filter((entry) => entry.descriptor.app === appName);
  if (matches.length === 0) {
    process.stderr.write(`aucune cible « ${appName} » sous ${options.root}\n`);
    return 1;
  }

  let entry: Entry;
  if (options.target !== undefined) {
    const found = matches.find((candidate) => candidate.descriptor.target === options.target);
    if (found === undefined) {
      process.stderr.write(
        `cible « ${options.target} » absente pour ${appName} (${matches.map((m) => m.descriptor.target).join(", ")})\n`,
      );
      return 1;
    }
    entry = found;
  } else if (matches.length === 1) {
    entry = matches[0]!;
  } else {
    process.stderr.write(
      `plusieurs cibles pour ${appName} (${matches.map((m) => m.descriptor.target).join(", ")}) — précise --target\n`,
    );
    return 1;
  }

  if (!options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Supprimer définitivement ${entry.descriptor.app}/${entry.descriptor.target} ?\n` +
        `Le dossier source (${entry.descriptor.source}) et les volumes de données ne sont pas touchés. [o/N] `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "o") {
      process.stdout.write("annulé\n");
      return 1;
    }
  }

  const compose = composeRunner((line) => {
    if (line.trim() !== "") process.stdout.write(`  │ ${line}\n`);
  });
  const result = await removeTarget(entry, compose, (path) => rm(path, { recursive: true, force: true }));
  if (result.code !== 0) {
    process.stderr.write(`${result.stderr || result.stdout}\n`);
    return 1;
  }

  process.stdout.write(`supprimé ${entry.directory}\n`);
  return 0;
}

/**
 * Trois vérifications qui partagent le même token d'accès API Tailscale, un
 * secret aux droits plus larges que tout ce que le daemon manipule ailleurs
 * — jamais lu depuis le daemon (`serve`) pour cette raison. Régénère
 * `--authkey-file` si l'échéance approche et révoque l'ancienne clé
 * (`rotate.ts`), signale les nœuds `tag:dbox` abandonnés (`orphans.ts`), et
 * vérifie que `--ts-tag` existe dans `tagOwners` (`tagcheck.ts`) — chacune
 * écrit son propre rapport, lu par le daemon pour /settings, jamais un appel
 * API depuis le daemon lui-même. `deploy/docker-compose.yml` la lance dans
 * son propre conteneur, sans le socket Docker, sans route depuis le sidecar.
 *
 * `--interval` la fait tourner en continu (pensé pour ce conteneur dédié) ;
 * sans lui, une passe unique puis sortie (pratique pour vérifier à la main,
 * ou pour qui préfère un cron/timer plutôt qu'un conteneur qui ne s'arrête
 * jamais).
 */
async function runRotateAuthkey(options: Options): Promise<number> {
  if (options.authkeyFile === undefined) {
    process.stderr.write("dbox rotate-authkey nécessite --authkey-file (ou authkey_file dans la config)\n");
    return 1;
  }
  if (options.apiTokenFile === undefined) {
    process.stderr.write("dbox rotate-authkey nécessite --api-token-file (ou déduit de --authkey-file)\n");
    return 1;
  }

  if (options.orphansReportFile === undefined) {
    process.stderr.write("dbox rotate-authkey nécessite --orphans-report-file (ou déduit de --authkey-file)\n");
    return 1;
  }
  if (options.tagReportFile === undefined) {
    process.stderr.write("dbox rotate-authkey nécessite --tag-report-file (ou déduit de --authkey-file)\n");
    return 1;
  }

  const log = (line: string) => process.stdout.write(`${line}\n`);
  // Absent (jamais posé) traité comme vide : les trois vérifications ci-dessous
  // savent déjà dire clairement « token absent » pour une chaîne vide — sans
  // ce filet, un fichier qui n'existe pas encore afficherait trois ENOENT
  // bruts au lieu d'un message qu'on comprend. Seulement ENOENT, précisément :
  // toute autre erreur (droits, disque) doit remonter telle quelle, pas se
  // faire passer pour un simple token pas encore posé.
  const readToken = () =>
    readFile(options.apiTokenFile!, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const write = async (path: string, content: string, mode: number) => {
    await writeFile(path, content, { mode });
  };

  const rotateDeps = {
    authkeyFile: options.authkeyFile,
    tailnet: options.tailnet,
    tag: options.tsTag,
    readFile: (path: string) => readFile(path, "utf8"),
    writeFile: write,
    readToken,
    createKey: createAuthKey,
    revokeKey: revokeAuthKey,
    now: Date.now,
    log,
  };

  // Même conteneur isolé, même token : autant profiter du passage périodique
  // pour signaler les nœuds Tailscale qui semblent abandonnés — jamais une
  // suppression automatique, un rapport écrit pour /settings (voir
  // orphans-report.ts) et dans les journaux. Sur l'ancienneté de `lastSeen`,
  // jamais une comparaison au registre local : chaque machine DBox ne gère
  // que ses propres cibles, comparer au registre d'une seule signalerait à
  // tort celles bien vivantes des autres (voir orphans.ts).
  const orphanDeps = {
    tailnet: options.tailnet,
    tag: options.tsTag,
    staleAfterMs: STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
    reportFile: options.orphansReportFile,
    readToken,
    writeFile: write,
    listDevices,
    now: Date.now,
    log,
  };

  // Même conteneur isolé, même token, encore : vérifie que --ts-tag existe
  // bien dans tagOwners — sinon dbox add échoue à l'inscription du nouveau
  // nœud sans que la cause saute aux yeux. Lecture seule : jamais d'écriture
  // de l'ACL (voir tailscale.ts), juste un rapport pour /settings.
  const tagDeps = {
    tailnet: options.tailnet,
    tag: options.tsTag,
    reportFile: options.tagReportFile,
    readToken,
    writeFile: write,
    listTagOwners,
    now: Date.now,
    log,
  };

  // Rotation de la clé préauth Headscale — seulement si tout est configuré
  // pour ce backend (fichier de clé, token d'API, user, serveur). Absente
  // sinon : une machine en Tailscale pur n'a rien à faire ici.
  const headscaleRotateDeps =
    options.headscaleAuthkeyFile !== undefined &&
    options.headscaleApiTokenFile !== undefined &&
    options.headscaleUser !== undefined &&
    options.headscaleLoginServer !== undefined
      ? {
          authkeyFile: options.headscaleAuthkeyFile,
          loginServer: options.headscaleLoginServer,
          user: options.headscaleUser,
          readFile: (path: string) => readFile(path, "utf8"),
          writeFile: write,
          // Son propre token, jamais celui de Tailscale — vit dans secrets/,
          // même masquage au daemon que le token Tailscale.
          readToken: () =>
            readFile(options.headscaleApiTokenFile!, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            }),
          createKey: createPreAuthKey,
          expireKey: expirePreAuthKey,
          now: Date.now,
          log,
        }
      : null;

  if (options.rotateIntervalMs === undefined) {
    let failed = false;
    const taches = [() => rotateOnce(rotateDeps), () => checkOrphansOnce(orphanDeps), () => checkTagOnce(tagDeps)];
    if (headscaleRotateDeps !== null) taches.push(() => rotateHeadscaleOnce(headscaleRotateDeps));
    for (const task of taches) {
      try {
        await task();
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  }

  process.stdout.write(
    `rotate-authkey · toutes les ${options.rotateIntervalMs / 1000}s · ${options.authkeyFile}\n`,
  );
  startRotating(options.rotateIntervalMs, rotateDeps);
  startCheckingOrphans(options.rotateIntervalMs, orphanDeps);
  startCheckingTag(options.rotateIntervalMs, tagDeps);
  if (headscaleRotateDeps !== null) startRotatingHeadscale(options.rotateIntervalMs, headscaleRotateDeps);
  return new Promise(() => {}); // ne se termine jamais, comme `serve`
}

function runServe(options: Options): Promise<number> {
  const compose = composeRunner();
  const ctx: Context = {
    ...DEFAULT_CONTEXT,
    root: options.root,
    tailnet: options.tailnet,
    tsTag: options.tsTag,
    traefik: traefikConfigFor(options),
    ...backendCtxFor(options),
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    // Écrasé pour chaque cible par le chemin lu dans son dbox.json.
    sourcePath: options.root,
  };
  const jobs = new Jobs();
  const scanRoot = () => scan(options.root, async () => (await run("docker", PS_ARGS)).stdout);
  const redeployTarget = (entry: Entry, log: (line: string) => void) =>
    redeploy(entry, compose, deployOptions(options, ctx), log);

  // `undefined` : cette machine n'a pas de config pour une clé dédiée — le
  // panneau « accès git » reste alors absent de la page, pas cassé. Une
  // clé par app en dépend : sans clé machine, pas de dossier à côté duquel
  // la ranger.
  const machineKeyFile = options.sshKeyFile;
  const sshPaths = machineKeyFile === undefined ? null : keyPaths(machineKeyFile);
  const sshKeyIo = {
    readFile: (path: string) => readFile(path, "utf8"),
    mkdir: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    chmod: (path: string, mode: number) => chmod(path, mode),
    run: (file: string, args: string[]) => run(file, args),
  };
  const sshKeyStatus =
    sshPaths === null
      ? undefined
      : async () => {
          const publicKey = await readPublicKey(sshPaths, sshKeyIo);
          return { exists: publicKey !== null, publicKey };
        };
  const appSshKeyStatus =
    machineKeyFile === undefined
      ? undefined
      : async (appName: string) => {
          const publicKey = await readPublicKey(keyPaths(appKeyFile(machineKeyFile, appName)), sshKeyIo);
          return { exists: publicKey !== null, publicKey };
        };

  // Lecture indépendante de `actions`, même règle que la clé SSH : un daemon
  // en lecture seule garde son sélecteur de machines, seule l'édition dépend
  // de la capacité d'écrire.
  const machinesFile = options.machinesFile;
  const machinesList =
    machinesFile === undefined ? undefined : () => readMachines(machinesFile, (p) => readFile(p, "utf8"));

  const workspacesRoot = options.workspacesRoot;
  const workspacesList =
    workspacesRoot === undefined
      ? undefined
      : () => listWorkspaces(workspacesRoot, (p) => readdir(p, { withFileTypes: true }), (p) => readFile(p, "utf8"));

  // Expiration du certificat wildcard headscale, en lecture seule, pour la
  // bannière de /settings. Lire le certificat demande un conteneur root (voir
  // readCertExpiry) : trop coûteux à chaque affichage, et la date bouge sur des
  // mois — on la met donc en cache quelques heures. Absente sans backend
  // headscale configuré, ou sans image-sonde pour lire le certificat.
  const certReader =
    ctx.headscale === null || options.probeImage === undefined || options.tailnet === undefined
      ? undefined
      : cacheExpiration(
          () => readCertExpiry(ctx.headscale!.certDir, options.tailnet!, options.probeImage!),
          6 * 60 * 60 * 1000,
        );

  const server = createServer({
    scan: scanRoot,
    now: Date.now,
    authkeyNotice: () => readAuthkeyNotice(options.authkeyFile, (p) => readFile(p, "utf8"), Date.now()),
    headscaleCertNotice:
      certReader === undefined
        ? undefined
        : async (): Promise<CertNotice | null> => {
            const iso = await certReader();
            return iso === null ? null : certNotice(iso, Date.now());
          },
    adminAuthkeyNotice: () => readAuthkeyNotice(options.adminAuthkeyFile, (p) => readFile(p, "utf8"), Date.now()),
    headscaleAuthkeyNotice: () =>
      readAuthkeyNotice(options.headscaleAuthkeyFile, (p) => readFile(p, "utf8"), Date.now()),
    // Statut lecture seule du backend headscale — absent si non configuré ici,
    // même règle que le panneau Traefik (ctx.headscale posé par backendCtxFor).
    headscale:
      ctx.headscale === null
        ? undefined
        : async () => ({
            loginServer: ctx.headscale!.loginServer,
            certDir: ctx.headscale!.certDir,
            authkeyFileConfigured: options.headscaleAuthkeyFile !== undefined,
          }),
    orphansReport:
      options.orphansReportFile === undefined
        ? undefined
        : () => readOrphansReport(options.orphansReportFile!, (p) => readFile(p, "utf8")),
    tagReport:
      options.tagReportFile === undefined
        ? undefined
        : () => readTagReport(options.tagReportFile!, (p) => readFile(p, "utf8")),
    // Ce que ce daemon a reçu au démarrage — affiché en lecture seule, il ne
    // peut pas le réécrire lui-même (ni config.toml ni deploy/.env montés).
    traefik: ctx.traefik === null ? undefined : { ...ctx.traefik },
    // Gravée dans l'image par deploy-to.sh (ARG DBOX_VERSION) — le conteneur
    // ne peut pas la déduire, il n'a ni git ni dépôt.
    version: process.env["DBOX_VERSION"],
    sshKeyStatus,
    listWorkspaces: workspacesList,
    allowedUsers: options.allowedUsers,
    // Jamais de fetch (voir versions.ts), et une minute de cache : la liste se
    // rend toutes les 15 s, par chaque onglet ouvert.
    versionInfo: avecCache((source, tag) => versionInfo(source, tag, (args) => run("git", args))),
    // Le même diagnostic que `dbox doctor`, sans token d'API : le tag se lit
    // dans le rapport du rotator, jamais en direct depuis le daemon.
    diagnostic: () =>
      diagnostic({
        ...effetsReels(options.root),
        tailnet: options.tailnet.includes("<") ? undefined : options.tailnet,
        tsTag: options.tsTag,
        root: options.root,
        authkeyFile: options.authkeyFile,
        configPresente: null,
        backend: options.backend,
        headscaleLoginServer: options.headscaleLoginServer,
        headscaleCertDir: options.headscaleCertDir,
        headscaleAuthkeyFile: options.headscaleAuthkeyFile,
        // Réutilise le lecteur mis en cache de la bannière : pas un second
        // conteneur à chaque diagnostic.
        certExpiry: certReader,
        tagReport:
          options.tagReportFile === undefined
            ? async () => null
            : () => readTagReport(options.tagReportFile!, (p) => readFile(p, "utf8")),
      }),
    appSshKeyStatus,
    machines: machinesList,
    workspacesRoot,
    actions: {
      compose,
      jobs,
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, { mode: 0o600 }),
      redeploy: redeployTarget,
      remove: (entry) => removeTarget(entry, compose, (path) => rm(path, { recursive: true, force: true })),
      add: (url, name, log, choice) => addApp(url, name, compose, deployOptions(options, ctx), log, choice),
      addLocal:
        workspacesRoot === undefined
          ? undefined
          : (relativePath, log, choice) =>
              addLocalApp(
                resolveWorkspacePath(workspacesRoot, relativePath),
                compose,
                deployOptions(options, ctx),
                log,
                choice,
              ),
      generateSshKey: sshPaths === null ? undefined : () => ensureKey(sshPaths, sshKeyIo),
      generateAppSshKey:
        machineKeyFile === undefined
          ? undefined
          : (appName: string) => ensureKey(keyPaths(appKeyFile(machineKeyFile, appName)), sshKeyIo),
      saveMachines:
        machinesFile === undefined
          ? undefined
          : (entries) => writeMachines(machinesFile, entries, (p, c) => writeFile(p, c, { mode: 0o600 })),
    },
  });

  // Même Jobs que les actions HTTP : un redéploiement manuel et un
  // redéploiement automatique de la même cible ne se marchent jamais dessus.
  const stopPolling =
    options.pollIntervalMs > 0
      ? startPolling(options.pollIntervalMs, {
          scan: scanRoot,
          checkUpstream: async (entry) =>
            checkUpstream(entry.descriptor.source, await resolveKeyFile(machineKeyFile, entry.descriptor.app, sshKeyIo)),
          redeploy: redeployTarget,
          jobs,
          log: (line) => process.stdout.write(`${line}\n`),
        })
      : () => {};

  return new Promise((resolve) => {
    server.on("error", (error: Error) => {
      stopPolling();
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    // 0.0.0.0 par défaut : en conteneur, le sidecar doit pouvoir l'atteindre par
    // le réseau du projet. Aucun port n'est publié sur l'hôte pour autant.
    server.listen(options.port, options.host, () => {
      process.stdout.write(`dbox serve · ${options.host}:${options.port} · racine ${options.root}\n`);
      if (options.pollIntervalMs > 0) {
        process.stdout.write(`  sondage auto_deploy toutes les ${options.pollIntervalMs / 1000}s\n`);
      }
    });
  });
}

function deployOptions(options: Options, ctx: Context) {
  return {
    ctx,
    timeoutMs: options.timeoutMs,
    authkeyFile: options.authkeyFile,
    headscaleAuthkeyFile: options.headscaleAuthkeyFile,
    probeImage: options.probeImage,
    sshKeyFile: options.sshKeyFile,
    sources: options.sources,
    defaultTarget: options.defaultTarget,
    readManifest: (path: string) => readFile(path, "utf8"),
    writeManifest: (path: string, content: string) => writeFile(path, content),
  };
}

function renderTable(entries: Entry[], now: number): string {
  const header = ["APP · CIBLE", "ÉTAT", "VERSION", "DEPUIS", "URL"];
  const rows = entries.map((entry) => [
    `${entry.descriptor.app} · ${entry.descriptor.target}`,
    entry.status,
    entry.state?.tag ?? "—",
    entry.state === null ? "—" : since(entry.state.deployedAt, now),
    entry.descriptor.url,
  ]);

  // La dernière colonne n'est pas complétée : inutile, et ça évite des espaces
  // en fin de ligne qui gênent le copier-coller de l'URL.
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => [...row[column]!].length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column]! + 2),
      )
      .join("")
      .trimEnd();

  return [line(header), ...rows.map(line)].join("\n") + "\n";
}

/**
 * La cible par défaut vient de la machine, pas du manifeste : c'est ce qui fait
 * qu'un même dépôt se déploie en `prod` depuis le serveur et en `dev` depuis le
 * poste, sans changer une ligne.
 */
function defaultTarget(manifest: Manifest, configured: string | undefined): string {
  const names = Object.keys(manifest.targets);

  if (configured !== undefined) {
    if (names.includes(configured)) return configured;
    throw new Error(
      `cette machine est réglée sur « ${configured} », absente du manifeste (cibles : ${names.join(", ")})`,
    );
  }

  if (names.includes("prod")) return "prod";
  if (names.length === 1) return names[0]!;
  throw new Error(`plusieurs cibles (${names.join(", ")}) — précise --target`);
}

function parseArgs(args: string[], config: Config = {}): Options {
  const options: Options = {
    directory: ".",
    write: false,
    root: config.root ?? DEFAULT_CONTEXT.root,
    tailnet: config.tailnet ?? process.env["DBOX_TAILNET"] ?? "<tailnet>.ts.net",
    tsTag: config.tsTag ?? DEFAULT_CONTEXT.tsTag,
    backend: config.backend ?? DEFAULT_CONTEXT.backend,
    headscaleLoginServer: config.headscaleLoginServer,
    headscaleCertDir: config.headscaleCertDir,
    headscaleAuthkeyFile: config.headscaleAuthkeyFile,
    headscaleApiTokenFile: config.headscaleApiTokenFile,
    headscaleUser: config.headscaleUser,
    probeImage: config.probeImage,
    traefikNetwork: config.traefikNetwork,
    traefikCertResolver: config.traefikCertResolver,
    authkeyFile: config.authkeyFile,
    // Même dossier par défaut, même règle que ssh_key/machines.json : pas de
    // question de plus à poser dans `dbox setup`.
    adminAuthkeyFile:
      config.adminAuthkeyFile ??
      (config.authkeyFile === undefined ? undefined : `${dirname(config.authkeyFile)}/admin-authkey`),
    // Même règle encore : à côté de la clé Tailscale, pas une question de plus.
    apiTokenFile:
      config.apiTokenFile ??
      (config.authkeyFile === undefined ? undefined : `${dirname(config.authkeyFile)}/tailscale-api-token`),
    orphansReportFile:
      config.orphansReportFile ??
      (config.authkeyFile === undefined ? undefined : `${dirname(config.authkeyFile)}/orphans-report.json`),
    tagReportFile:
      config.tagReportFile ??
      (config.authkeyFile === undefined ? undefined : `${dirname(config.authkeyFile)}/tag-report.json`),
    // À côté de la clé Tailscale par défaut : même dossier `~/dbox`, pas de
    // question de plus à poser dans `dbox setup`.
    sshKeyFile:
      config.sshKeyFile ?? (config.authkeyFile === undefined ? undefined : `${dirname(config.authkeyFile)}/ssh_key`),
    machinesFile:
      config.machinesFile ??
      (config.authkeyFile === undefined ? undefined : `${dirname(config.authkeyFile)}/machines.json`),
    // Pas de défaut déduit : contrairement à ssh_key/machines.json, rien à
    // côté de la clé Tailscale n'a de sens ici — chaque machine a ses propres
    // dossiers de travail, à poser explicitement.
    workspacesRoot: config.workspacesRoot,
    defaultTarget: config.target,
    sources: config.sources ?? dirname(config.root ?? DEFAULT_CONTEXT.root),
    pull: false,
    yes: false,
    timeoutMs: 180_000,
    port: 8099,
    host: "0.0.0.0",
    pollIntervalMs: 300_000,
  };

  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--write":
        options.write = true;
        break;
      case "--target":
        options.target = expect(args, ++i, arg);
        break;
      case "--root":
        options.root = expect(args, ++i, arg);
        break;
      case "--tailnet":
        options.tailnet = expect(args, ++i, arg);
        break;
      case "--tag":
        options.tag = expect(args, ++i, arg);
        break;
      case "--ts-tag": {
        // Chaîne vide = ne rien annoncer, tant que `tagOwners` n'est pas déclaré.
        const value = expect(args, ++i, arg);
        options.tsTag = value === "" ? null : value;
        break;
      }
      case "--backend": {
        const value = expect(args, ++i, arg);
        if (value !== "tailscale" && value !== "headscale") {
          throw new Error(`--backend attend « tailscale » ou « headscale » (reçu « ${value} »)`);
        }
        options.backend = value;
        break;
      }
      // Chaîne vide = non renseigné, même idiome que --traefik-network : le
      // passage par deploy/docker-compose.yml pose toujours la variable.
      case "--headscale-login-server": {
        const value = expect(args, ++i, arg);
        options.headscaleLoginServer = value === "" ? undefined : value;
        break;
      }
      case "--headscale-cert-dir": {
        const value = expect(args, ++i, arg);
        options.headscaleCertDir = value === "" ? undefined : value;
        break;
      }
      case "--headscale-authkey-file": {
        const value = expect(args, ++i, arg);
        options.headscaleAuthkeyFile = value === "" ? undefined : value;
        break;
      }
      case "--headscale-api-token-file": {
        const value = expect(args, ++i, arg);
        options.headscaleApiTokenFile = value === "" ? undefined : value;
        break;
      }
      case "--headscale-user": {
        const value = expect(args, ++i, arg);
        options.headscaleUser = value === "" ? undefined : value;
        break;
      }
      case "--probe-image": {
        const value = expect(args, ++i, arg);
        options.probeImage = value === "" ? undefined : value;
        break;
      }
      // Chaîne vide = non renseigné, même idiome que --workspaces-root : le
      // passage par deploy/docker-compose.yml pose toujours la variable.
      case "--traefik-network": {
        const value = expect(args, ++i, arg);
        if (value !== "") options.traefikNetwork = value;
        break;
      }
      case "--traefik-cert-resolver": {
        const value = expect(args, ++i, arg);
        if (value !== "") options.traefikCertResolver = value;
        break;
      }
      case "--sources":
        options.sources = expect(args, ++i, arg);
        break;
      case "--name":
        options.name = expect(args, ++i, arg);
        break;
      case "--pull":
        options.pull = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--authkey-file":
        options.authkeyFile = expect(args, ++i, arg);
        break;
      case "--admin-authkey-file":
        options.adminAuthkeyFile = expect(args, ++i, arg);
        break;
      case "--api-token-file":
        options.apiTokenFile = expect(args, ++i, arg);
        break;
      case "--orphans-report-file":
        options.orphansReportFile = expect(args, ++i, arg);
        break;
      case "--tag-report-file":
        options.tagReportFile = expect(args, ++i, arg);
        break;
      case "--interval": {
        const seconds = Number(expect(args, ++i, arg));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--interval attend des secondes");
        options.rotateIntervalMs = seconds * 1000;
        break;
      }
      case "--ssh-key-file":
        options.sshKeyFile = expect(args, ++i, arg);
        break;
      case "--machines-file":
        options.machinesFile = expect(args, ++i, arg);
        break;
      case "--workspaces-root": {
        const value = expect(args, ++i, arg);
        if (value !== "") options.workspacesRoot = value;
        break;
      }
      case "--host":
        options.host = expect(args, ++i, arg);
        break;
      case "--port": {
        const value = Number(expect(args, ++i, arg));
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error("--port attend un entier entre 1 et 65535");
        }
        options.port = value;
        break;
      }
      case "--timeout": {
        const seconds = Number(expect(args, ++i, arg));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout attend des secondes");
        options.timeoutMs = seconds * 1000;
        break;
      }
      case "--poll-interval": {
        const seconds = Number(expect(args, ++i, arg));
        // 0 est valide : c'est la façon d'éteindre le sondage.
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--poll-interval attend des secondes");
        options.pollIntervalMs = seconds * 1000;
        break;
      }
      case "--allowed-users": {
        // CSV plutôt qu'option répétée : plus simple à poser depuis une seule
        // variable d'environnement dans deploy/docker-compose.yml. Minuscules
        // pour une comparaison insensible à la casse, vide ignoré.
        options.allowedUsers = expect(args, ++i, arg)
          .split(",")
          .map((u) => u.trim().toLowerCase())
          .filter((u) => u !== "");
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`option inconnue « ${arg} »`);
        if (positional) throw new Error(`argument en trop « ${arg} »`);
        options.directory = arg;
        positional = true;
    }
  }

  return options;
}

function expect(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new Error(`${flag} attend une valeur`);
  return value;
}

function render(plan: Plan): string {
  const out = [
    "",
    `${plan.app} · cible ${plan.target}`,
    `  URL       ${plan.url}`,
    `  santé     ${plan.healthUrl}`,
    `  mode      ${plan.mode}`,
    `  amont     ${plan.upstream}`,
    `  projet    ${plan.project}`,
    "",
  ];

  for (const file of plan.files) {
    const permissions = file.mode === undefined ? "" : ` (${file.mode.toString(8).padStart(4, "0")})`;
    const preserved = file.preserveIfExists === true ? " · préservé s'il existe" : "";
    out.push(`──── ${file.path}${permissions}${preserved} ────`, file.content.trimEnd(), "");
  }

  return out.join("\n");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
