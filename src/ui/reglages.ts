/**
 * La page /settings : ce qui vaut pour toute la machine, pas pour une cible.
 *
 * Presque tout y est en **lecture seule** — le conteneur du daemon ne voit ni
 * `config.toml` ni `deploy/.env`, il ne peut que montrer ce qu'il a reçu au
 * démarrage. Seule la liste des machines connues s'y édite.
 */

import type { AuthkeyNotice } from "../authkey.ts";
import type { CertNotice } from "../cert.ts";
import type { MachineEntry } from "../machines.ts";
import type { OrphansReport } from "../orphans-report.ts";
import type { TagReport } from "../tag-report.ts";
import { since } from "../registry.ts";
import { machineSelector, PWA_HEAD, SCRIPT, STYLE, VENDOR_SCRIPTS } from "./chrome.ts";
import type { Constat } from "../doctor.ts";
import { escape } from "./html.ts";

/**
 * Les réglages du mode public que ce daemon a reçus **au démarrage** — jamais
 * éditables depuis la page : le conteneur du daemon ne voit ni `config.toml` ni
 * `deploy/.env` (aucun des deux n'est monté), il ne peut que montrer ce avec
 * quoi il a été lancé. Les changer reste un geste sur l'hôte, suivi d'un
 * redémarrage du conteneur.
 */
export interface TraefikStatus {
  network: string;
  certResolver: string;
}

/**
 * Ce que le daemon a chargé au démarrage pour le backend headscale — jamais
 * éditable depuis ici : le conteneur ne voit ni config.toml ni deploy/.env,
 * seulement ses arguments de lancement. Un constat, comme le panneau Traefik.
 */
export interface HeadscaleStatus {
  loginServer: string;
  certDir: string;
  authkeyFileConfigured: boolean;
}

export interface SshKeyStatus {
  exists: boolean;
  publicKey: string | null;
  canGenerate: boolean;
}

/**
 * La config générale : ce qui vaut pour toutes les apps, pas une cible en
 * particulier — l'accès git, et les autres machines DBox connues. Le reste
 * (démarrer/arrêter, `.env`, `dbox.toml`) reste sur la carte de chaque app,
 * là où il s'applique.
 */
export function renderSettingsPage(
  viewer: string | null,
  authkeyNotice: AuthkeyNotice | null = null,
  sshKey: SshKeyStatus | null = null,
  machines: MachineEntry[] = [],
  canManageMachines = false,
  adminAuthkeyNotice: AuthkeyNotice | null = null,
  orphansReport: OrphansReport | null = null,
  tagReport: TagReport | null = null,
  now: number = Date.now(),
  traefik: TraefikStatus | null = null,
  version: string | null = null,
  diagnosticDisponible = false,
  headscale: HeadscaleStatus | null = null,
  headscaleAuthkeyNotice: AuthkeyNotice | null = null,
  headscaleCertNotice: CertNotice | null = null,
): string {
  return `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DBox — réglages</title>
${PWA_HEAD}
<style>${STYLE}</style>
<body>
<header>
  <h1>DBox — réglages</h1>
  ${machineSelector(machines)}
  <div class="entete-droite">
    ${viewer === null ? "" : `<span class="viewer">${escape(viewer)}</span>`}
    <a class="reglages" href="/">← Retour</a>
  </div>
</header>
${etatMachine([
  ...authkeyLignes(authkeyItems(authkeyNotice, adminAuthkeyNotice, headscaleAuthkeyNotice)),
  orphansLigne(orphansReport, now),
  tagLigne(tagReport, now),
  traefikLigne(traefik),
  headscaleLigne(headscale),
  headscaleCertLigne(headscaleCertNotice),
  versionLigne(version),
])}
${diagnosticDisponible ? diagnosticPanel() : ""}
<div id="cle-machine">${sshKeyPanel(sshKey)}</div>
${machinesPanel(machines, canManageMachines)}
${VENDOR_SCRIPTS}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const WARN_WITHIN_DAYS = 14;

/**
 * Une ligne de la page des réglages : soit un **constat** (tout va bien, voici
 * l'état), soit un **avis** (il y a quelque chose à faire).
 */
interface Ligne {
  avis: boolean;
  html: string;
}

/**
 * Les avis d'abord, seuls et pleine largeur — ils appellent un geste. Les
 * constats ensuite, rassemblés sous un titre : ils flottaient en texte nu
 * au-dessus de panneaux encadrés, sans qu'on sache s'ils formaient un tout ou
 * s'étaient échappés du panneau du dessous.
 *
 * Le bloc disparaît entièrement s'il n'y a rien à constater — une machine sans
 * rapport, sans clé et sans version n'a pas à porter un cadre vide.
 */
function etatMachine(lignes: (Ligne | null)[]): string {
  const vraies = lignes.filter((l): l is Ligne => l !== null);
  const avis = vraies.filter((l) => l.avis).map((l) => l.html);
  const constats = vraies.filter((l) => !l.avis).map((l) => l.html);

  const bloc =
    constats.length === 0
      ? ""
      : `<section class="etat-machine">
  <h2>État de la machine</h2>
  ${constats.join("")}
</section>`;

  return `${avis.join("")}${bloc}`;
}

/**
 * Deux clés distinctes peuvent expirer indépendamment : celle qui sème les
 * nouvelles apps (`tag:dbox`), et celle du daemon lui-même (`tag:dbox-admin`,
 * `deploy/ts.env`) — la seconde n'était couverte par aucune bannière avant
 * qu'on ne l'y ajoute, alors qu'elle est plus grave à laisser filer : sans
 * elle, c'est le tableau de bord entier qui devient injoignable.
 */
interface AuthkeyItem {
  label: string;
  notice: AuthkeyNotice;
  expiredMsg: string;
  okMsg: string;
  /** Où régénérer — différent pour Tailscale (console web) et Headscale (CLI
   * sur le serveur qui l'héberge). */
  hint: string;
}

const TS_HINT = "Settings → Keys → Generate auth key, puis pose la valeur dans le fichier de clé sur chaque machine.";
const HEADSCALE_HINT =
  "headscale preauthkeys create --reusable --expiration 90d (ou laisse le rotator le faire), puis pose la valeur et <fichier>.expires sur chaque machine.";

export
function authkeyItems(
  seed: AuthkeyNotice | null,
  admin: AuthkeyNotice | null,
  headscale: AuthkeyNotice | null = null,
): AuthkeyItem[] {
  const items: AuthkeyItem[] = [];
  if (seed !== null) {
    items.push({
      label: "Clé Tailscale",
      notice: seed,
      expiredMsg: "les nouvelles apps ne peuvent plus s'inscrire tant qu'elle n'est pas régénérée.",
      okMsg: "les apps déjà en place ne sont pas affectées ; seules les prochaines app le seront.",
      hint: TS_HINT,
    });
  }
  if (admin !== null) {
    items.push({
      label: "Clé Tailscale du daemon",
      notice: admin,
      expiredMsg: "ce daemon ne pourra plus rejoindre le tailnet à son prochain redémarrage — le tableau de bord deviendrait injoignable.",
      okMsg: "n'affecte que ce daemon, pas les apps qu'il gère.",
      hint: TS_HINT,
    });
  }
  if (headscale !== null) {
    items.push({
      label: "Clé préauth Headscale",
      notice: headscale,
      expiredMsg: "les nouvelles apps headscale ne peuvent plus s'inscrire tant qu'elle n'est pas régénérée.",
      okMsg: "les apps headscale déjà en place ne sont pas affectées ; seules les prochaines le seront.",
      hint: HEADSCALE_HINT,
    });
  }
  return items;
}

/**
 * La bannière du certificat wildcard headscale. Fenêtre d'alerte plus large que
 * pour une clé (30 j) : un certificat Let's Encrypt se renouvelle d'habitude à
 * ~30 j de l'échéance, donc en deçà c'est que le renouvellement automatique n'a
 * pas eu lieu — le moment d'alerter. Son expiration casserait le TLS de **toutes**
 * les cibles headscale d'un coup, d'où l'avis fort.
 */
const CERT_WARN_WITHIN_DAYS = 30;

function headscaleCertLigne(cert: CertNotice | null): Ligne | null {
  if (cert === null) return null;
  const expired = cert.daysLeft < 0;
  const quand = expired
    ? `expiré depuis ${-cert.daysLeft} j (${escape(cert.expiresOn)})`
    : cert.daysLeft === 0
      ? "expire aujourd'hui"
      : `expire dans ${cert.daysLeft} j (${escape(cert.expiresOn)})`;

  if (!expired && cert.daysLeft > CERT_WARN_WITHIN_DAYS) {
    return { avis: false, html: `<p class="cle-info">Certificat Headscale : ${quand}.</p>` };
  }
  return {
    avis: true,
    html: `<div class="avis ${expired ? "avis-fort" : "avis-doux"}">
  Certificat wildcard Headscale ${quand} — s'il expire, toutes les cibles headscale perdent leur TLS d'un coup.<br>Renouvelle-le (ton script lego/DNS-01) ; Caddy reprend le nouveau fichier sans intervention.
</div>`,
  };
}

function authkeyText(item: AuthkeyItem): { quand: string; consequence: string; expired: boolean } {
  const { notice } = item;
  const expired = notice.daysLeft < 0;
  const quand = expired
    ? `expirée depuis ${-notice.daysLeft} j (${escape(notice.expiresOn)})`
    : notice.daysLeft === 0
      ? "expire aujourd'hui"
      : `expire dans ${notice.daysLeft} j (${escape(notice.expiresOn)})`;
  const consequence = expired ? item.expiredMsg : item.okMsg;
  return { quand, consequence, expired };
}

/** Silencieuse tant que l'échéance est loin — c'est la version pour la liste
 * des apps, où l'alerte doit rester rare pour rester lue quand elle apparaît. */
export
function authkeyBanner(items: AuthkeyItem[]): string {
  return items
    .filter((item) => item.notice.daysLeft < 0 || item.notice.daysLeft <= WARN_WITHIN_DAYS)
    .map((item) => {
      const { quand, consequence, expired } = authkeyText(item);
      return `<div class="avis ${expired ? "avis-fort" : "avis-doux"}">
  ${escape(item.label)} ${quand} — ${consequence}<br>${escape(item.hint)}
</div>`;
    })
    .join("");
}

/**
 * La version pour /settings : toujours visible, même loin de l'échéance —
 * un rappel factuel plutôt qu'une alerte tant que rien n'est urgent, la même
 * bannière colorée une fois dans la fenêtre d'avertissement.
 */
function authkeyLignes(items: AuthkeyItem[]): Ligne[] {
  return items.map((item) => {
    const { quand, consequence, expired } = authkeyText(item);
    if (!expired && item.notice.daysLeft > WARN_WITHIN_DAYS) {
      return { avis: false, html: `<p class="cle-info">${escape(item.label)} : ${quand}.</p>` };
    }
    return {
      avis: true,
      html: `<div class="avis ${expired ? "avis-fort" : "avis-doux"}">
  ${escape(item.label)} ${quand} — ${consequence}<br>${escape(item.hint)}
</div>`,
    };
  });
}

/**
 * Écrit par `dbox rotate-authkey` (`orphans.ts`), lu ici tel quel — le
 * daemon n'appelle jamais l'API Tailscale lui-même. Absent (fichier jamais
 * écrit, ou machine sans `authkey-rotator`) : rien ne s'affiche, même règle
 * que la bannière de clé. Jamais de bouton « supprimer » ici : un rapport à
 * lire, pas une action.
 */
function orphansLigne(report: OrphansReport | null, now: number): Ligne | null {
  if (report === null) return null;

  if (report.stale.length === 0) {
    return {
      avis: false,
      html: `<p class="cle-info">Nœuds Tailscale : aucun abandonné (vérifié ${escape(since(report.checkedAt, now))}).</p>`,
    };
  }

  const lignes = report.stale
    .map((device) => `${escape(device.hostname)} — vu pour la dernière fois ${escape(since(device.lastSeen, now))}`)
    .join("<br>");
  return { avis: true, html: `<div class="avis avis-doux">
  ${report.stale.length} nœud(s) Tailscale <code>${escape(report.tag)}</code> sans connexion depuis longtemps (vérifié ${escape(since(report.checkedAt, now))}) :<br>
  ${lignes}<br>
  À vérifier dans la console Tailscale avant de les retirer soi-même — DBox ne les supprime jamais automatiquement.
</div>` };
}

/**
 * Écrit par `dbox rotate-authkey` (`tagcheck.ts`), lu ici tel quel — DBox ne
 * réécrit jamais l'ACL lui-même (voir `tailscale.ts` : la policy gouverne
 * tout le tailnet d'un coup, un correctif ciblé n'est pas possible côté
 * API). Juste une ligne prête à coller, calquée sur un tag déjà présent.
 */
function tagLigne(report: TagReport | null, now: number): Ligne | null {
  if (report === null) return null;

  if (report.present) {
    return {
      avis: false,
      html: `<p class="cle-info">Tag Tailscale <code>${escape(report.tag)}</code> : déclaré dans tagOwners (vérifié ${escape(since(report.checkedAt, now))}).</p>`,
    };
  }

  return { avis: true, html: `<div class="avis avis-doux">
  Tag Tailscale <code>${escape(report.tag)}</code> absent de <code>tagOwners</code> (vérifié ${escape(since(report.checkedAt, now))}) — l'ajout d'une nouvelle app échouerait à son inscription.
  Colle cette ligne dans Settings → Access controls → Policies, dans <code>tagOwners</code> :
  <div class="publique">${escape(report.suggestedLine ?? "")}</div>
</div>` };
}

/**
 * Absent quand le mode public n'est pas configuré sur cette machine : rien ne
 * s'affiche, même règle que les rapports ci-dessus. Lecture seule — voir
 * `TraefikStatus` : ces réglages arrivent par la ligne de commande du
 * conteneur, qui ne peut pas les réécrire lui-même.
 */
function traefikLigne(status: TraefikStatus | null): Ligne | null {
  if (status === null) return null;

  return { avis: false, html: `<p class="cle-info">
  Mode public : réseau <code>${escape(status.network)}</code>, resolver
  <code>${escape(status.certResolver)}</code> — une cible n'est exposée que si son
  <code>dbox.toml</code> pose <code>public_domain</code>.
</p>` };
}

/**
 * Lecture seule, comme le panneau Traefik : ces réglages arrivent par la ligne
 * de commande du conteneur, qui ne peut ni les éditer ni toucher config.toml /
 * deploy/.env. Absent quand le backend headscale n'est pas configuré ici.
 */
function headscaleLigne(status: HeadscaleStatus | null): Ligne | null {
  if (status === null) return null;

  return { avis: false, html: `<p class="cle-info">
  Backend Headscale : serveur <code>${escape(status.loginServer)}</code>, certificat dans
  <code>${escape(status.certDir)}</code>, clé préauth ${status.authkeyFileConfigured ? "configurée" : "<strong>absente</strong>"} —
  une cible l'emploie si son <code>dbox.toml</code> pose <code>backend = "headscale"</code> (ou le défaut machine).
</p>` };
}

/**
 * La version que ce daemon exécute — gravée dans l'image à sa construction
 * (`ARG DBOX_VERSION`), jamais déduite à l'exécution : le conteneur n'a ni git
 * ni dépôt sous la main. Répond à « mon déploiement est-il bien passé ? » sans
 * ouvrir un SSH. Même convention que le tag d'une app (`tag.ts`) : SHA court,
 * suffixé `-sale` si l'arbre d'origine était modifié.
 *
 * « inconnue » quand l'image a été construite à la main, sans passer par
 * `deploy-to.sh` — affiché tel quel plutôt que masqué : c'est une information
 * en soi.
 */
function versionLigne(version: string | null): Ligne | null {
  if (version === null || version === "") return null;

  const sale = version.endsWith("-sale")
    ? " — construite depuis un arbre modifié, ce n'est donc pas exactement ce commit"
    : "";
  return { avis: false, html: `<p class="cle-info">Version du daemon : <code>${escape(version)}</code>${sale}.</p>` };
}

/**
 * Toujours affiché tel quel au premier rendu ; l'édition dépend de
 * `canManage` — un daemon en lecture seule montre la liste sans bouton pour
 * la changer, le sélecteur de l'en-tête continue de fonctionner quand même.
 * La liste elle-même (ajouter/retirer une ligne) est purement Alpine, jamais
 * un aller-retour serveur avant l'enregistrement.
 */
function machinesPanel(machines: MachineEntry[], canManage: boolean): string {
  if (machines.length === 0 && !canManage) return "";

  const lignesInit = JSON.stringify(machines.map((m) => ({ a: m.name, b: m.url })));

  const pied = canManage
    ? `<div class="conf-pied">
    <button type="button" @click="ajouter()">Ajouter</button>
    <button type="submit">Enregistrer</button>
  </div>`
    : "";

  return `<form class="cle-ssh" x-data="dbListe(${escape(lignesInit)})"
  hx-post="/api/machines" hx-target="#sortie-machines" hx-swap="innerHTML">
  <div class="ligne">
    <span class="titre">Machines connues</span>
  </div>
  <p>Les autres tableaux de bord DBox accessibles depuis le sélecteur en haut
  de page — chacune reste indépendante, cette liste n'est pas partagée entre
  machines.</p>
  <div class="machines-liste">
    <template x-for="(ligne, i) in lignes" :key="ligne.id">
      <div class="var">
        <input name="nom" x-model="ligne.a" placeholder="nom" ${canManage ? "" : "disabled"}>
        <input name="url" x-model="ligne.b" placeholder="https://…" ${canManage ? "" : "disabled"}>
        ${canManage ? `<button type="button" @click="retirer(i)">×</button>` : ""}
      </div>
    </template>
  </div>
  ${pied}
  <div id="sortie-machines"></div>
</form>`;
}

/**
 * Absent (pas de `sshKeyStatus` sur cette machine) : rien ne s'affiche — c'est
 * la même règle que la bannière de clé Tailscale, un renseignement optionnel,
 * jamais une condition.
 */
export function sshKeyPanel(sshKey: SshKeyStatus | null): string {
  if (sshKey === null) return "";

  if (!sshKey.exists) {
    const bouton = sshKey.canGenerate
      ? `<button hx-post="/api/ssh-key" hx-target="#cle-machine" hx-swap="innerHTML" hx-disabled-elt="this">Générer</button>`
      : `<span class="etat arretee">non configurée</span>`;
    return `<div class="cle-ssh">
  <div class="ligne">
    <span class="titre">Accès git</span>
    ${bouton}
  </div>
  <p>Aucune clé SSH dédiée. Elle sert uniquement aux dépôts que tu ajoutes
  depuis DBox — pas ta clé personnelle, révocable indépendamment.</p>
</div>`;
  }

  return `<div class="cle-ssh">
  <div class="ligne">
    <span class="titre">Accès git</span>
    <button type="button" onclick="navigator.clipboard.writeText(this.closest('.cle-ssh').querySelector('.publique').textContent); this.textContent='copié'; setTimeout(()=>this.textContent='Copier',1400)">Copier</button>
  </div>
  <div class="publique">${escape(sshKey.publicKey ?? "")}</div>
  <p>Colle cette clé publique dans les <em>Deploy keys</em> (GitHub) ou
  <em>Deploy tokens</em> (GitLab) du dépôt que tu veux ajouter — un dépôt à la
  fois, jamais un accès à tout ton compte.</p>
</div>`;
}

/**
 * Le même diagnostic que `dbox doctor`, lancé à la demande : il interroge le
 * réseau (MagicDNS, chaque app en HTTPS), quelques secondes que la page ne
 * doit pas imposer à chaque ouverture. Lecture seule, comme la commande.
 */
function diagnosticPanel(): string {
  return `<section class="cle-ssh diagnostic">
  <div class="ligne"><span class="titre">Diagnostic</span>
    <button type="button" hx-get="/api/diagnostic" hx-target="#resultat-diagnostic" hx-swap="innerHTML"
      hx-disabled-elt="this" hx-indicator="#resultat-diagnostic">Lancer</button></div>
  <p>Les prérequis de cette machine, vérifiés comme <code>dbox doctor</code> : Docker, clé Tailscale, réseau privé, HTTPS, tag ACL, disque. Rien n'est modifié.</p>
  <div id="resultat-diagnostic" role="status" aria-live="polite"></div>
</section>`;
}

const NIVEAUX: Record<Constat["niveau"], { symbole: string; classe: string; texte: string }> = {
  ok: { symbole: "✔", classe: "marche", texte: "bon" },
  attention: { symbole: "⚠", classe: "partielle", texte: "à surveiller" },
  bloquant: { symbole: "✘", classe: "bloquant", texte: "bloquant" },
  info: { symbole: "·", classe: "jamais", texte: "information" },
};

export function diagnosticFragment(constats: Constat[]): string {
  const lignes = constats
    .map((c) => {
      const n = NIVEAUX[c.niveau];
      const correction =
        c.correction === undefined || c.niveau === "ok" ? "" : `<div class="correction">→ ${escape(c.correction)}</div>`;
      return `<li class="constat"><span class="${n.classe}" title="${n.texte}" aria-label="${n.texte}">${n.symbole}</span>
  <span><strong>${escape(c.sujet)}</strong> — ${escape(c.message)}${correction}</span></li>`;
    })
    .join("");
  const b = constats.filter((c) => c.niveau === "bloquant").length;
  const a = constats.filter((c) => c.niveau === "attention").length;
  const bilan = b === 0 && a === 0 ? "tout est prêt" : [b > 0 ? `${b} bloquant${b > 1 ? "s" : ""}` : "", a > 0 ? `${a} à surveiller` : ""].filter(Boolean).join(", ");
  return `<ul class="constats">${lignes}</ul><p class="bilan">${escape(bilan)}</p>`;
}
