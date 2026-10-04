/**
 * `dbox doctor` — ce qui empêcherait DBox de marcher sur cette machine, dit
 * avant qu'un déploiement ne l'apprenne à ses dépens.
 *
 * Chaque contrôle vise un prérequis du démarrage (doc/INSTALL.md) ou un piège
 * déjà rencontré pour de vrai : une clé d'auth avec du texte en trop (un
 * `chmod` collé dans le fichier), une machine hors du tailnet (la santé
 * échoue alors que l'app tourne), les certificats HTTPS jamais activés, un
 * tag absent de `tagOwners`.
 *
 * **Lecture seule, toujours.** Le diagnostic n'écrit rien, ne crée aucun
 * dossier, ne corrige rien : il dit quoi faire. Les effets passent tous par
 * `DoctorDeps`, que la CLI et le daemon remplissent chacun avec ce qu'ils ont
 * le droit de lire — le daemon, en particulier, ne lit jamais le token d'API
 * Tailscale (voir `tagOwners`).
 */

import { readAuthkeyNotice } from "./authkey.ts";
import type { TagReport } from "./tag-report.ts";

export type Niveau = "ok" | "attention" | "bloquant" | "info";

export interface Constat {
  sujet: string;
  niveau: Niveau;
  message: string;
  /** Le geste qui règle le problème — absent quand il n'y a rien à faire. */
  correction?: string;
}

export interface DoctorDeps {
  tailnet: string | undefined;
  tsTag: string | null;
  root: string;
  authkeyFile: string | undefined;
  /** `false` en CLI quand `~/.config/dbox/config.toml` manque ; le daemon,
   * configuré par sa ligne de commande, passe `null` (sans objet). */
  configPresente: boolean | null;
  docker: () => Promise<{ ok: boolean; detail: string }>;
  readFile: (path: string) => Promise<string>;
  /** Permissions d'un fichier (`mode & 0o777`), `null` s'il est absent. */
  permissions: (path: string) => Promise<number | null>;
  ecrivable: (dir: string) => Promise<boolean>;
  /** Octets libres sur le système de fichiers de `dir`, `null` si inconnu. */
  espaceLibre: (dir: string) => Promise<number | null>;
  /** MagicDNS (100.100.100.100) répond-il ? C'est la preuve la plus simple
   * que cette machine est sur le tailnet. */
  magicDns: (tailnet: string) => Promise<boolean>;
  /** Les cibles déployées, pour vérifier qu'elles répondent en HTTPS. */
  cibles: () => Promise<{ label: string; url: string }[]>;
  /** Statut HTTP, `null` si injoignable — avec un délai borné. */
  probe: (url: string) => Promise<number | null>;
  /** Le résolveur du système (celui que `fetch` utilise) trouve-t-il ce nom ?
   * MagicDNS peut répondre en direct alors que le résolveur, lui, interroge un
   * DNS amont qui ignore le tailnet — vécu dans le conteneur du lanceur. */
  resoudre: (hote: string) => Promise<boolean>;
  tagReport: () => Promise<TagReport | null>;
  /** Lecture directe de `tagOwners` via l'API — **CLI seulement**, quand le
   * rapport du rotator manque et qu'un token est posé. Le daemon ne le fournit
   * jamais : le token d'API ne doit pas lui être lisible. */
  tagOwners?: () => Promise<Record<string, string[]> | null>;
  now: () => number;
}

const CLE = /^tskey-auth-[A-Za-z0-9_-]+$/;
const GIO = 1024 ** 3;
const MAX_CIBLES_SONDEES = 6;

export async function diagnostic(deps: DoctorDeps): Promise<Constat[]> {
  const constats: Constat[] = [];
  const ajoute = (c: Constat) => constats.push(c);

  // ── Docker ────────────────────────────────────────────────────────────────
  const docker = await deps.docker().catch((e: Error) => ({ ok: false, detail: e.message }));
  ajoute(
    docker.ok
      ? { sujet: "Docker", niveau: "ok", message: `répond (${docker.detail})` }
      : {
          sujet: "Docker",
          niveau: "bloquant",
          message: `injoignable : ${docker.detail}`,
          correction: "installer Docker, et l'utiliser sans sudo (groupe docker, puis rouvrir la session)",
        },
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  if (deps.configPresente === false) {
    ajoute({
      sujet: "Configuration",
      niveau: "attention",
      message: "~/.config/dbox/config.toml absent : chaque commande demandera ses options",
      correction: "dbox setup",
    });
  }
  if (deps.tailnet === undefined || deps.tailnet === "") {
    ajoute({
      sujet: "Tailnet",
      niveau: "bloquant",
      message: "non renseigné : DBox ne peut construire aucune adresse",
      correction: "dbox setup, ou tailnet = \"…\" dans ~/.config/dbox/config.toml",
    });
  } else {
    ajoute({ sujet: "Tailnet", niveau: "ok", message: deps.tailnet });
  }

  // ── Clé d'authentification ───────────────────────────────────────────────
  await controleCle(deps, ajoute);

  // ── Sur le tailnet ? ─────────────────────────────────────────────────────
  if (deps.tailnet !== undefined && deps.tailnet !== "") {
    const joignable = await deps.magicDns(deps.tailnet).catch(() => false);
    ajoute(
      joignable
        ? { sujet: "Réseau privé", niveau: "ok", message: "cette machine est sur le tailnet (MagicDNS répond)" }
        : {
            sujet: "Réseau privé",
            niveau: "bloquant",
            message: "MagicDNS ne répond pas : cette machine ne semble pas sur le tailnet",
            correction:
              "installer Tailscale sur cette machine et s'y connecter (tailscale up) — le contrôle de santé passe par l'adresse finale de chaque app",
          },
    );
  }

  // ── HTTPS, vu depuis les apps déjà déployées ─────────────────────────────
  await controleHttps(deps, ajoute);

  // ── Tag dans tagOwners ───────────────────────────────────────────────────
  await controleTag(deps, ajoute);

  // ── Disque ───────────────────────────────────────────────────────────────
  const ecrivable = await deps.ecrivable(deps.root).catch(() => false);
  ajoute(
    ecrivable
      ? { sujet: "Racine", niveau: "ok", message: `${deps.root} accessible en écriture` }
      : {
          sujet: "Racine",
          niveau: "bloquant",
          message: `${deps.root} absente ou non accessible en écriture`,
          correction: `mkdir -p ${deps.root} (en tant que l'utilisateur qui lance DBox)`,
        },
  );
  const libre = await deps.espaceLibre(deps.root).catch(() => null);
  if (libre !== null) {
    const gio = libre / GIO;
    const texte = `${gio.toFixed(1)} Gio libres`;
    ajoute(
      gio < 2
        ? { sujet: "Espace disque", niveau: "bloquant", message: texte, correction: "docker image prune, ou libérer de la place : une construction échouera" }
        : gio < 10
          ? { sujet: "Espace disque", niveau: "attention", message: texte, correction: "chaque déploiement garde son image : docker image prune de temps en temps" }
          : { sujet: "Espace disque", niveau: "ok", message: texte },
    );
  }

  return constats;
}

async function controleCle(deps: DoctorDeps, ajoute: (c: Constat) => void): Promise<void> {
  const fichier = deps.authkeyFile;
  if (fichier === undefined) {
    ajoute({
      sujet: "Clé Tailscale",
      niveau: "attention",
      message: "aucun fichier de clé configuré : chaque nouvelle app demandera sa clé à la main",
      correction: "authkey_file dans ~/.config/dbox/config.toml (dbox setup le propose)",
    });
    return;
  }
  const contenu = await deps.readFile(fichier).catch(() => null);
  if (contenu === null) {
    ajoute({
      sujet: "Clé Tailscale",
      niveau: "bloquant",
      message: `${fichier} absent`,
      correction: `echo 'tskey-auth-…' > ${fichier} puis, dans une commande séparée, chmod 600 ${fichier}`,
    });
    return;
  }
  // Jamais la valeur dans un message : seulement sa forme.
  const propre = contenu.trim();
  if (propre === "") {
    ajoute({ sujet: "Clé Tailscale", niveau: "bloquant", message: `${fichier} est vide`, correction: `y poser la clé : echo 'tskey-auth-…' > ${fichier}` });
    return;
  }
  if (!CLE.test(propre)) {
    const lignes = propre.split("\n").length;
    ajoute({
      sujet: "Clé Tailscale",
      niveau: "bloquant",
      message:
        lignes > 1
          ? `${fichier} contient ${lignes} lignes : rien d'autre que la clé ne doit y être`
          : propre.startsWith("tskey-")
            ? `${fichier} contient une clé tskey-, mais pas une clé d'authentification (tskey-auth-…)`
            : `${fichier} ne contient pas une clé tskey-auth-…`,
      correction: "réécrire le fichier avec la seule clé, sans espace ni texte autour (piège vécu : un chmod collé dans le fichier)",
    });
    return;
  }
  const mode = await deps.permissions(fichier).catch(() => null);
  if (mode !== null && (mode & 0o077) !== 0) {
    ajoute({
      sujet: "Clé Tailscale",
      niveau: "attention",
      message: `${fichier} est lisible par d'autres utilisateurs (${mode.toString(8)})`,
      correction: `chmod 600 ${fichier}`,
    });
  }
  const echeance = await readAuthkeyNotice(fichier, deps.readFile, deps.now()).catch(() => null);
  if (echeance === null) {
    ajoute({ sujet: "Clé Tailscale", niveau: "ok", message: "présente et bien formée (échéance inconnue)" });
  } else if (echeance.daysLeft < 0) {
    ajoute({
      sujet: "Clé Tailscale",
      niveau: "bloquant",
      message: `expirée depuis ${-echeance.daysLeft} j (${echeance.expiresOn}) : aucune nouvelle app ne pourra s'inscrire`,
      correction: "console Tailscale → Settings → Keys → Generate auth key, puis la poser dans le fichier",
    });
  } else if (echeance.daysLeft <= 14) {
    ajoute({
      sujet: "Clé Tailscale",
      niveau: "attention",
      message: `expire dans ${echeance.daysLeft} j (${echeance.expiresOn})`,
      correction: "la régénérer bientôt — ou laisser dbox rotate-authkey le faire",
    });
  } else {
    ajoute({ sujet: "Clé Tailscale", niveau: "ok", message: `présente, expire dans ${echeance.daysLeft} j` });
  }
}

async function controleHttps(deps: DoctorDeps, ajoute: (c: Constat) => void): Promise<void> {
  const cibles = (await deps.cibles().catch(() => [])).slice(0, MAX_CIBLES_SONDEES);
  if (cibles.length === 0) {
    ajoute({ sujet: "HTTPS", niveau: "info", message: "aucune app déployée : le premier dbox up le vérifiera" });
    return;
  }
  const resultats = await Promise.all(
    cibles.map(async (c) => ({ ...c, statut: await deps.probe(c.url).catch(() => null) })),
  );
  const muettes = resultats.filter((r) => r.statut === null);
  if (muettes.length === 0) {
    ajoute({ sujet: "HTTPS", niveau: "ok", message: `${resultats.length} app${resultats.length > 1 ? "s répondent" : " répond"} en HTTPS` });
  } else if (muettes.length === resultats.length && !(await deps.resoudre(new URL(muettes[0]!.url).hostname).catch(() => true))) {
    ajoute({
      sujet: "HTTPS",
      niveau: "bloquant",
      message: `les noms du tailnet ne se résolvent pas ici (${new URL(muettes[0]!.url).hostname}) : le contrôle de santé échouera toujours`,
      correction:
        "sur la machine : tailscale set --accept-dns=true ; avec le lanceur dbox, relancer install.sh (il tourne sur le réseau dbox-cli, dont le DNS connaît le tailnet)",
    });
  } else if (muettes.length === resultats.length) {
    ajoute({
      sujet: "HTTPS",
      niveau: "attention",
      message: `aucune app ne répond en HTTPS (${muettes.map((m) => m.label).join(", ")})`,
      correction: "console Tailscale → DNS : activer MagicDNS et HTTPS Certificates ; sinon, docker logs <projet>-tailscale-1",
    });
  } else {
    ajoute({
      sujet: "HTTPS",
      niveau: "attention",
      message: `ne répondent pas : ${muettes.map((m) => m.label).join(", ")}`,
      correction: "dbox ls pour leur état ; docker logs <projet>-tailscale-1 pour leur sidecar",
    });
  }
}

async function controleTag(deps: DoctorDeps, ajoute: (c: Constat) => void): Promise<void> {
  const tag = deps.tsTag;
  if (tag === null) return;

  const rapport = await deps.tagReport().catch(() => null);
  if (rapport !== null && rapport.tag === tag) {
    ajoute(
      rapport.present
        ? { sujet: "Tag ACL", niveau: "ok", message: `${tag} déclaré dans tagOwners` }
        : {
            sujet: "Tag ACL",
            niveau: "bloquant",
            message: `${tag} absent de tagOwners : aucune nouvelle app ne pourra s'inscrire`,
            correction: `console Tailscale → Access controls, dans tagOwners : ${rapport.suggestedLine ?? `"${tag}": ["autogroup:admin"],`}`,
          },
    );
    return;
  }

  const owners = deps.tagOwners === undefined ? null : await deps.tagOwners().catch(() => null);
  if (owners === null) {
    ajoute({
      sujet: "Tag ACL",
      niveau: "info",
      message: `${tag} : non vérifiable ici (ni rapport du rotator, ni token d'API)`,
      correction: `vérifier que tagOwners contient "${tag}" dans la console Tailscale`,
    });
    return;
  }
  ajoute(
    tag in owners
      ? { sujet: "Tag ACL", niveau: "ok", message: `${tag} déclaré dans tagOwners` }
      : {
          sujet: "Tag ACL",
          niveau: "bloquant",
          message: `${tag} absent de tagOwners : aucune nouvelle app ne pourra s'inscrire`,
          correction: `console Tailscale → Access controls, dans tagOwners : "${tag}": ["autogroup:admin"],`,
        },
  );
}

const SYMBOLES: Record<Niveau, string> = { ok: "✔", attention: "⚠", bloquant: "✘", info: "·" };

/** Le rendu texte de la CLI. */
export function formaterTexte(constats: Constat[]): string {
  const largeur = Math.max(...constats.map((c) => c.sujet.length));
  const lignes = constats.flatMap((c) => {
    const tete = `  ${SYMBOLES[c.niveau]} ${c.sujet.padEnd(largeur)}  ${c.message}`;
    return c.correction === undefined || c.niveau === "ok" ? [tete] : [tete, `    ${" ".repeat(largeur)}→ ${c.correction}`];
  });
  const b = constats.filter((c) => c.niveau === "bloquant").length;
  const a = constats.filter((c) => c.niveau === "attention").length;
  const bilan =
    b === 0 && a === 0
      ? "tout est prêt"
      : [b > 0 ? `${b} bloquant${b > 1 ? "s" : ""}` : "", a > 0 ? `${a} à surveiller` : ""].filter(Boolean).join(", ");
  return `${lignes.join("\n")}\n\n${bilan}\n`;
}

export function aDesBloquants(constats: Constat[]): boolean {
  return constats.some((c) => c.niveau === "bloquant");
}
