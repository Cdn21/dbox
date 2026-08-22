/**
 * La page servie par le daemon.
 *
 * Rendue côté serveur ; l'interactivité passe par htmx (requêtes déclarées en
 * attributs, le serveur répond en HTML) et Alpine (état purement local — un
 * champ qui s'affiche ou pas, une ligne qu'on ajoute à un formulaire). Les
 * deux sont vendorisés (`vendor.ts`), jamais chargés depuis un CDN : la page
 * ne dépend toujours de rien d'externe, juste de moins de JS écrit à la main.
 */

import type { AuthkeyNotice } from "./authkey.ts";
import type { Entry } from "./registry.ts";
import { since } from "./registry.ts";
import type { MachineEntry } from "./machines.ts";
import type { Target } from "./manifest.ts";
import type { OrphansReport } from "./orphans-report.ts";
import type { TagReport } from "./tag-report.ts";

/**
 * Installable comme app — « Ajouter à l'écran d'accueil » depuis le
 * navigateur, sans rien empaqueter : ni Electron, ni build, la page se sert
 * déjà elle-même. `start_url` reste relatif à l'origine du tailnet, jamais
 * un domaine en dur — la même app installée sur deux machines pointe chacune
 * vers son propre `<nom>.<tailnet>.ts.net`.
 */
export const MANIFEST_JSON = JSON.stringify(
  {
    name: "DBox",
    short_name: "DBox",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#15171a",
    theme_color: "#2f6fed",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  },
  null,
  2,
);

/** Un « D » blanc sur fond bleu — la même couleur d'accent que les boutons
 * principaux de la page, plutôt qu'une icône sans rapport avec l'app. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#2f6fed"/>
  <text x="50" y="70" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="58" font-weight="700" fill="#fff" text-anchor="middle">D</text>
</svg>
`;

const PWA_HEAD = `<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#2f6fed">`;

const STYLE = `
:root { color-scheme: light dark; --fond:#fff; --texte:#111; --doux:#666; --bord:#e3e3e3; --carte:#fafafa;
  --accent:#2f6fed; --accent-texte:#fff; --actif:#eef2fb; }
@media (prefers-color-scheme: dark) {
  :root { --fond:#15171a; --texte:#e9eaec; --doux:#9aa0a6; --bord:#2b2f34; --carte:#1b1e22;
    --accent:#5b8dfa; --accent-texte:#0b1220; --actif:#1e2a44; }
}
* { box-sizing:border-box; }
[x-cloak] { display:none !important; }
body { margin:0; padding:1.25rem 1rem 3rem; background:var(--fond); color:var(--texte);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
header { display:flex; align-items:baseline; gap:.6rem; margin-bottom:1.25rem; }
h1 { font-size:1.35rem; margin:0; letter-spacing:-.01em; }
.entete-droite { margin-left:auto; display:flex; align-items:center; gap:.7rem; }
.viewer { color:var(--doux); font-size:.85rem; }
.machine-select { font:inherit; font-size:.85rem; padding:.25rem .5rem; border-radius:7px;
  border:1px solid var(--bord); background:var(--fond); color:inherit; }
.reglages { color:var(--doux); font-size:.85rem; text-decoration:none; border-bottom:1px solid var(--bord); }
ul { list-style:none; margin:0; padding:0; display:grid; gap:.7rem; }
li { border:1px solid var(--bord); border-radius:12px; background:var(--carte); padding:.85rem .95rem; }
.ligne { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
.nom { font-weight:600; }
.cible { color:var(--doux); font-weight:400; }
.etat { font-size:.78rem; padding:.12rem .5rem; border-radius:999px; border:1px solid currentColor; }
.marche { color:#1a7f37; } .arretee { color:var(--doux); } .partielle,.redemarre { color:#bf5b00; }
.jamais { color:var(--doux); }
.meta { color:var(--doux); font-size:.85rem; margin-top:.35rem; }
a.url { display:inline-block; margin-top:.5rem; color:inherit; text-decoration:none;
  border-bottom:1px solid var(--bord); word-break:break-all; }
.actions { display:flex; flex-direction:column; gap:.5rem; margin-top:.75rem; }
.principales, .secondaires, .dangereuses { display:flex; gap:.45rem; flex-wrap:wrap; }
button { font:inherit; font-size:.85rem; padding:.35rem .75rem; border-radius:8px; cursor:pointer;
  border:1px solid var(--bord); background:transparent; color:inherit; }
button:active { transform:translateY(1px); }
button[disabled], button.htmx-request { opacity:.45; cursor:default; }
/* htmx pose « htmx-request » sur l'émetteur de la requête — pour un
   formulaire, c'est le formulaire lui-même, pas ses boutons ; ce sélecteur
   les atteint quand même, sans avoir à lister chaque bouton un par un. */
form.htmx-request button { opacity:.45; pointer-events:none; }
/* L'action qui fait vraiment quelque chose (redéployer, démarrer/arrêter) se
   distingue des panneaux de détail — le regard va d'abord là, pas dispersé
   sur cinq boutons de poids égal. */
.principales button { font-weight:600; }
.principales button.redeployer { background:var(--accent); border-color:var(--accent); color:var(--accent-texte); }
.secondaires button { border-color:transparent; color:var(--doux); font-size:.8rem; padding:.3rem .6rem; }
.dangereuses button { border-color:transparent; color:#d4183399; font-size:.8rem; padding:.3rem .6rem; }
.dangereuses button:hover { color:#d41833; }
pre { margin:.65rem 0 0; padding:.6rem; border:1px solid var(--bord); border-radius:8px;
  background:var(--fond); color:var(--doux); font-size:.78rem; line-height:1.45;
  max-height:16rem; overflow:auto; white-space:pre-wrap; word-break:break-word; }
.vide { color:var(--doux); }
.avis { border-radius:12px; padding:.7rem .95rem; margin-bottom:1rem; font-size:.88rem; }
.avis-doux { border:1px solid #bf5b0055; background:#bf5b0012; color:inherit; }
.avis-fort { border:1px solid #d4183355; background:#d4183312; color:inherit; }
.cle-info { color:var(--doux); font-size:.85rem; margin:0 0 1rem; }
.conf { margin-top:.7rem; display:grid; gap:.4rem; }
.var { display:flex; gap:.35rem; }
.var input { flex:1; min-width:0; font:inherit; font-size:.85rem; padding:.3rem .5rem;
  border:1px solid var(--bord); border-radius:7px; background:var(--fond); color:inherit; }
.var input.cle { flex:0 0 40%; }
.var button { flex:0 0 auto; padding:.3rem .55rem; }
.conf-pied { display:flex; gap:.45rem; align-items:center; flex-wrap:wrap; }
.conf-pied label { color:var(--doux); font-size:.8rem; display:flex; gap:.3rem; align-items:center; }
.reglages-champs { display:flex; gap:.7rem; flex-wrap:wrap; align-items:end; }
/* Un champ étiqueté : le label reste visible une fois le champ rempli — un
   repère qu'un simple placeholder perd dès la première frappe. */
.champ { display:flex; flex-direction:column; gap:.25rem; font-size:.78rem; color:var(--doux);
  flex:1; min-width:8rem; }
.champ input, .champ select { width:100%; font:inherit; font-size:.85rem; padding:.35rem .5rem;
  border:1px solid var(--bord); border-radius:7px; background:var(--fond); color:var(--texte); }
.reglage-auto { display:flex; flex-direction:row; align-items:center; gap:.35rem; font-size:.8rem; color:var(--doux); }
.ajout { border:1px dashed var(--bord); border-radius:12px; padding:.85rem .95rem; margin-bottom:1rem; }
.ajout .ligne { gap:.5rem; align-items:end; }
.ajout .champ-depot { min-width:14rem; }
.ajout .champ-nom { flex:0 0 9rem; }
.ajout .champ-mode { flex:0 0 12rem; }
.ajout .champ-port { flex:0 0 6rem; }
.ajout button[type="submit"] { flex:0 0 auto; }
.cle-ssh { border:1px solid var(--bord); border-radius:12px; padding:.85rem .95rem; margin-bottom:1rem; }
.cle-ssh .ligne { justify-content:space-between; }
.cle-ssh .titre { font-weight:600; font-size:.9rem; }
.cle-ssh .publique { margin-top:.6rem; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.78rem;
  background:var(--carte); border:1px solid var(--bord); border-radius:8px; padding:.6rem .7rem;
  word-break:break-all; }
.cle-ssh p { margin:.5rem 0 0; color:var(--doux); font-size:.85rem; }
`;

/**
 * Le seul JS qui reste écrit à la main : enregistrer les composants Alpine
 * (avant qu'Alpine ne s'initialise), poser l'en-tête maison sur chaque
 * requête htmx, présélectionner la machine du sélecteur — trois choses que
 * ni htmx ni Alpine ne peuvent déduire tout seuls.
 */
const SCRIPT = `
document.addEventListener("alpine:init", () => {
  // Une liste de paires nom/valeur qu'on édite — le .env d'une cible et les
  // machines connues ont la même forme, ce composant sert aux deux.
  Alpine.data("dbListe", (lignes) => ({
    lignes: lignes.map((l, i) => ({ ...l, id: i })),
    prochainId: lignes.length,
    ajouter() { this.lignes.push({ a: "", b: "", id: this.prochainId++ }); },
    retirer(i) { this.lignes.splice(i, 1); },
  }));
});

// htmx ne pose jamais cet en-tête tout seul — sans lui, un site tiers qui
// forgerait une requête similaire serait bloqué par le CORS preflight que ça
// déclenche, l'identité Tailscale étant injectée par le proxy indépendamment
// de l'origine de la requête.
document.body.addEventListener("htmx:configRequest", (e) => {
  e.detail.headers["x-dbox-action"] = "1";
});

// Présélectionne la machine affichée en comparant l'origine courante à la
// liste — plus fiable que de faire deviner au serveur sa propre URL
// publique. Absente de la liste configurée : une option de secours l'y place.
document.querySelectorAll("select.machine-select").forEach((sel) => {
  const ici = location.origin;
  const trouvee = [...sel.options].find((o) => o.value === ici);
  if (trouvee) {
    trouvee.selected = true;
  } else {
    const option = document.createElement("option");
    option.value = ici;
    option.textContent = location.hostname + " (ici)";
    option.selected = true;
    sel.prepend(option);
  }
});

`;

const CLASSES: Record<string, string> = {
  "en marche": "marche",
  arrêtée: "arretee",
  partielle: "partielle",
  redémarre: "redemarre",
  "jamais démarrée": "jamais",
};

export interface SshKeyStatus {
  exists: boolean;
  publicKey: string | null;
  canGenerate: boolean;
}

/** Chargés localement, jamais depuis un CDN — voir `vendor.ts`. */
const VENDOR_SCRIPTS = `<script src="/htmx.js"></script>
<script src="/alpine.js" defer></script>`;

export function renderPage(
  entries: Entry[],
  now: number,
  viewer: string | null,
  actionable = false,
  authkeyNotice: AuthkeyNotice | null = null,
  machines: MachineEntry[] = [],
  workspacesRoot: string | null = null,
  workspaceProjects: { name: string; command: string | null }[] = [],
  adminAuthkeyNotice: AuthkeyNotice | null = null,
): string {
  // htmx se sonde lui-même : le formulaire d'ajout et les panneaux .conf
  // (variables, manifeste) restent en dehors de #cartes, jamais retouchés par
  // le sondage. Un panneau .conf ouvert *dans* une carte suspend quand même
  // le sondage — sans quoi une édition en cours y serait écrasée au bout de
  // 15 s, comme la carte entière est remplacée à chaque passage.
  const sondage = actionable
    ? ` hx-get="/api/apps/list" hx-trigger="every 15s [!document.hidden && !document.querySelector('.htmx-request') && !document.querySelector('#cartes .conf')]" hx-swap="innerHTML"`
    : "";
  const cartes = `<div id="cartes"${sondage}>${renderList(entries, now, actionable)}</div>`;

  const ajout = actionable ? renderAjout(workspacesRoot, workspaceProjects) : "";

  return `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DBox</title>
${PWA_HEAD}
<style>${STYLE}</style>
<body>
<header>
  <h1>DBox</h1>
  ${machineSelector(machines)}
  <div class="entete-droite">
    ${viewer === null ? "" : `<span class="viewer">${escape(viewer)}</span>`}
    ${actionable ? `<a class="reglages" href="/settings">Réglages</a>` : ""}
  </div>
</header>
${authkeyBanner(authkeyItems(authkeyNotice, adminAuthkeyNotice))}
${ajout}
${cartes}
${actionable ? `${VENDOR_SCRIPTS}\n<script>${SCRIPT}</script>` : ""}
</body>
</html>
`;
}

/**
 * Le formulaire d'ajout, en formulaire HTML natif : htmx sérialise les champs
 * nommés tout seul, pas besoin de les relire à la main en JS. Alpine gère le
 * seul état purement local — quels champs montrer selon la source et le mode
 * choisis, jamais envoyé au serveur tel quel.
 */
function renderAjout(workspacesRoot: string | null, workspaceProjects: { name: string; command: string | null }[]): string {
  // Seuls les projets avec un script `dev` détecté entrent dans la table —
  // les autres n'ont rien à suggérer, `commandes[nom]` vaut alors `undefined`
  // et le champ Commande se vide simplement au changement de dossier.
  const commandesParProjet = JSON.stringify(
    Object.fromEntries(workspaceProjects.filter((p) => p.command !== null).map((p) => [p.name, p.command])),
  );
  const champLocal =
    workspacesRoot === null
      ? ""
      : `<label class="champ champ-depot" x-show="source === 'local'" x-cloak>
      <span>Dossier (sous ${escape(workspacesRoot)})</span>
      <select name="path" @change="command = commandes[$event.target.value] || ''">
        <option value="">— choisir —</option>
        ${workspaceProjects.map((p) => `<option value="${escape(p.name)}">${escape(p.name)}</option>`).join("")}
      </select>
    </label>`;
  const sourceToggle =
    workspacesRoot === null
      ? ""
      : `<label class="champ champ-source">
      <span>Source</span>
      <select x-model="source">
        <option value="git">Dépôt git</option>
        <option value="local">Dossier local</option>
      </select>
    </label>`;

  return `<form
  class="ajout"
  x-data="{ source: 'git', mode: 'deployed', command: '', commandes: ${escape(commandesParProjet)} }"
  hx-post="/api/apps"
  hx-target="#sortie-ajout"
  hx-swap="innerHTML"
>
  <div class="ligne">
    ${sourceToggle}
    <label class="champ champ-depot" x-show="source === 'git'">
      <span>Dépôt</span>
      <input name="url" placeholder="git@github.com:moi/mon-app.git" spellcheck="false" autocapitalize="off">
    </label>
    <label class="champ champ-nom" x-show="source === 'git'">
      <span>Nom (optionnel)</span>
      <input name="name" spellcheck="false" autocapitalize="off">
    </label>
    ${champLocal}
    <label class="champ champ-mode">
      <span>Mode</span>
      <select name="mode" x-model="mode">
        <option value="deployed">prod — image construite</option>
        <option value="workspace">dev — processus sur cette machine</option>
        <option value="devcontainer">dev — conteneur, code monté</option>
      </select>
    </label>
    <button type="submit">Ajouter</button>
  </div>
  <div class="ligne" x-show="mode !== 'deployed'" x-cloak>
    <label class="champ champ-port">
      <span>Port</span>
      <input name="port" type="number" min="1" max="65535">
    </label>
    <label class="champ">
      <span>Commande</span>
      <input name="command" x-model="command" placeholder="npm run dev" spellcheck="false" autocapitalize="off">
    </label>
  </div>
  <div id="sortie-ajout"></div>
</form>`;
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
${authkeyStatus(authkeyItems(authkeyNotice, adminAuthkeyNotice))}
${orphansPanel(orphansReport, now)}
${tagPanel(tagReport, now)}
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
}

function authkeyItems(seed: AuthkeyNotice | null, admin: AuthkeyNotice | null): AuthkeyItem[] {
  const items: AuthkeyItem[] = [];
  if (seed !== null) {
    items.push({
      label: "Clé Tailscale",
      notice: seed,
      expiredMsg: "les nouvelles apps ne peuvent plus s'inscrire tant qu'elle n'est pas régénérée.",
      okMsg: "les apps déjà en place ne sont pas affectées ; seules les prochaines app le seront.",
    });
  }
  if (admin !== null) {
    items.push({
      label: "Clé Tailscale du daemon",
      notice: admin,
      expiredMsg: "ce daemon ne pourra plus rejoindre le tailnet à son prochain redémarrage — le tableau de bord deviendrait injoignable.",
      okMsg: "n'affecte que ce daemon, pas les apps qu'il gère.",
    });
  }
  return items;
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
function authkeyBanner(items: AuthkeyItem[]): string {
  return items
    .filter((item) => item.notice.daysLeft < 0 || item.notice.daysLeft <= WARN_WITHIN_DAYS)
    .map((item) => {
      const { quand, consequence, expired } = authkeyText(item);
      return `<div class="avis ${expired ? "avis-fort" : "avis-doux"}">
  ${escape(item.label)} ${quand} — ${consequence}<br>Settings → Keys → Generate auth key, puis pose la valeur dans le fichier de clé sur chaque machine.
</div>`;
    })
    .join("");
}

/**
 * La version pour /settings : toujours visible, même loin de l'échéance —
 * un rappel factuel plutôt qu'une alerte tant que rien n'est urgent, la même
 * bannière colorée une fois dans la fenêtre d'avertissement.
 */
function authkeyStatus(items: AuthkeyItem[]): string {
  return items
    .map((item) => {
      const { quand, consequence, expired } = authkeyText(item);
      if (!expired && item.notice.daysLeft > WARN_WITHIN_DAYS) {
        return `<p class="cle-info">${escape(item.label)} : ${quand}.</p>`;
      }
      return `<div class="avis ${expired ? "avis-fort" : "avis-doux"}">
  ${escape(item.label)} ${quand} — ${consequence}<br>Settings → Keys → Generate auth key, puis pose la valeur dans le fichier de clé sur chaque machine.
</div>`;
    })
    .join("");
}

/**
 * Écrit par `dbox rotate-authkey` (`orphans.ts`), lu ici tel quel — le
 * daemon n'appelle jamais l'API Tailscale lui-même. Absent (fichier jamais
 * écrit, ou machine sans `authkey-rotator`) : rien ne s'affiche, même règle
 * que la bannière de clé. Jamais de bouton « supprimer » ici : un rapport à
 * lire, pas une action.
 */
function orphansPanel(report: OrphansReport | null, now: number): string {
  if (report === null) return "";

  if (report.stale.length === 0) {
    return `<p class="cle-info">Nœuds Tailscale : aucun abandonné (vérifié ${escape(since(report.checkedAt, now))}).</p>`;
  }

  const lignes = report.stale
    .map((device) => `${escape(device.hostname)} — vu pour la dernière fois ${escape(since(device.lastSeen, now))}`)
    .join("<br>");
  return `<div class="avis avis-doux">
  ${report.stale.length} nœud(s) Tailscale <code>${escape(report.tag)}</code> sans connexion depuis longtemps (vérifié ${escape(since(report.checkedAt, now))}) :<br>
  ${lignes}<br>
  À vérifier dans la console Tailscale avant de les retirer soi-même — DBox ne les supprime jamais automatiquement.
</div>`;
}

/**
 * Écrit par `dbox rotate-authkey` (`tagcheck.ts`), lu ici tel quel — DBox ne
 * réécrit jamais l'ACL lui-même (voir `tailscale.ts` : la policy gouverne
 * tout le tailnet d'un coup, un correctif ciblé n'est pas possible côté
 * API). Juste une ligne prête à coller, calquée sur un tag déjà présent.
 */
function tagPanel(report: TagReport | null, now: number): string {
  if (report === null) return "";

  if (report.present) {
    return `<p class="cle-info">Tag Tailscale <code>${escape(report.tag)}</code> : déclaré dans tagOwners (vérifié ${escape(since(report.checkedAt, now))}).</p>`;
  }

  return `<div class="avis avis-doux">
  Tag Tailscale <code>${escape(report.tag)}</code> absent de <code>tagOwners</code> (vérifié ${escape(since(report.checkedAt, now))}) — l'ajout d'une nouvelle app échouerait à son inscription.
  Colle cette ligne dans Settings → Access controls → Policies, dans <code>tagOwners</code> :
  <div class="publique">${escape(report.suggestedLine ?? "")}</div>
</div>`;
}

/**
 * Absent quand aucune autre machine n'est connue : pas la peine d'un menu à
 * une seule entrée. La présélection de « celle qu'on regarde » se fait côté
 * client (SCRIPT) — comparer `location.origin` est plus fiable que de faire
 * deviner au serveur sa propre URL publique.
 */
function machineSelector(machines: MachineEntry[]): string {
  if (machines.length === 0) return "";

  const options = machines
    .map((m) => `<option value="${escape(m.url)}">${escape(m.name)}</option>`)
    .join("");
  return `<select class="machine-select" onchange="if(this.value && this.value !== location.origin) location.href = this.value">${options}</select>`;
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
 * Le pendant de `sshKeyPanel`, pour la clé d'une app en particulier — rendu
 * en fragment (jamais la page entière), utilisé au premier affichage du
 * panneau Manifeste et renvoyé tel quel après une génération.
 */
export function cleAppFragment(app: string, cle: { exists: boolean; publicKey: string | null } | null): string {
  if (cle === null) return ""; // cette machine ne gère pas les clés par app

  if (!cle.exists) {
    return `<div class="cle-ssh" id="cle-app-${escape(app)}">
  <div class="ligne">
    <span class="titre">Accès git dédié</span>
    <button
      hx-post="/api/apps/${encodeURIComponent(app)}/ssh-key"
      hx-target="#cle-app-${escape(app)}"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
    >Générer</button>
  </div>
  <p>Par défaut, cette app clone avec la clé de la machine. Une clé dédiée se
  révoque plus tard sans toucher aux autres apps.</p>
</div>`;
  }

  return `<div class="cle-ssh" id="cle-app-${escape(app)}">
  <div class="ligne">
    <span class="titre">Accès git dédié</span>
    <button type="button" onclick="navigator.clipboard.writeText(this.closest('.cle-ssh').querySelector('.publique').textContent); this.textContent='copié'; setTimeout(()=>this.textContent='Copier',1400)">Copier</button>
  </div>
  <div class="publique">${escape(cle.publicKey ?? "")}</div>
  <p>Colle-la dans les Deploy keys (GitHub) ou Deploy tokens (GitLab) du dépôt
  de cette app : le prochain redéploiement l'utilisera à la place de la clé
  machine.</p>
</div>`;
}

/**
 * Le fragment servi tel quel par `/api/apps/list` — sondé par htmx (voir
 * `renderPage`) pour garder le tableau de bord à jour sans recharger la page
 * entière, contrairement au formulaire d'ajout qui reste en dehors de #cartes.
 */
export function renderList(entries: Entry[], now: number, actionable: boolean): string {
  return entries.length === 0
    ? `<p class="vide">Aucune cible déployée.</p>`
    : `<ul>${entries.map((entry) => card(entry, now, actionable)).join("")}</ul>`;
}

function card(entry: Entry, now: number, actionable: boolean): string {
  const { descriptor: d, state, status } = entry;
  const version = state === null ? "jamais déployée" : `${escape(state.tag)} · ${since(state.deployedAt, now)}`;
  const id = domId(d.app, d.target);

  return `<li id="carte-${id}">
  <div class="ligne">
    <span class="nom">${escape(d.app)} <span class="cible">· ${escape(d.target)}</span></span>
    <span class="etat ${CLASSES[status] ?? ""}">${escape(status)}</span>
  </div>
  <div class="meta">${version} · ${escape(d.mode)}</div>
  <a class="url" href="${escape(d.url)}">${escape(d.url)}</a>
  ${actionable ? buttons(d.app, d.target, status) : ""}
  ${actionable ? `<div id="panneau-${id}"></div><div id="sortie-${id}"></div>` : ""}
</li>`;
}

function buttons(app: string, target: string, status: string): string {
  const running = status === "en marche" || status === "partielle" || status === "redémarre";
  const id = domId(app, target);
  const base = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}`;

  // Ce qui agit sur la cible d'un côté (principales), ce qui donne à voir de
  // l'autre (secondaires) — deux poids visuels différents, pas cinq boutons
  // à égalité où l'œil ne sait pas où se poser.
  const principales = [
    `<button class="redeployer" hx-post="${base}/up" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this">Redéployer</button>`,
    running
      ? `<button hx-post="${base}/stop" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this">Arrêter</button>`
      : `<button hx-post="${base}/start" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this">Démarrer</button>`,
  ].join("");

  const secondaires = [
    ["env", "Variables"],
    ["manifest", "Manifeste"],
  ]
    .map(
      ([action, label]) =>
        `<button hx-get="${base}/${action}" hx-target="#panneau-${id}" hx-swap="innerHTML" hx-disabled-elt="this">${label}</button>`,
    )
    .join("") +
    `<button hx-get="${base}/logs?lines=200" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this">Journaux</button>`;

  // Séparée des deux autres groupes, jamais adjacente à « Redéployer » : un
  // clic n'a pas à hésiter entre deux boutons de poids visuel comparable dont
  // l'un est irréversible. La confirmation (`hx-confirm`) suffit ici — pas de
  // second panneau à construire pour un geste qu'on ne fait qu'une fois.
  const suppression = `<button class="supprimer" hx-post="${base}/remove" hx-target="#sortie-${id}" hx-swap="innerHTML"
    hx-confirm="Supprimer définitivement ${escape(app)}/${escape(target)} ? Le dossier source et les volumes de données ne sont pas touchés." hx-disabled-elt="this">Supprimer</button>`;

  return `<div class="actions">
    <div class="principales">${principales}</div>
    <div class="secondaires">${secondaires}</div>
    <div class="dangereuses">${suppression}</div>
  </div>`;
}

/**
 * Le panneau « Variables » : un `.env` édité comme une liste de paires,
 * purement Alpine côté client (ajouter/retirer une ligne, montrer/cacher les
 * valeurs) — htmx ne sert qu'à poser le formulaire soumis, pas à le
 * construire.
 */
export function envPanelFragment(app: string, target: string, entries: { key: string; value: string }[]): string {
  const id = domId(app, target);
  const base = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}`;
  const initial = entries.length === 0 ? [{ key: "", value: "" }] : entries;
  const lignesInit = JSON.stringify(initial.map((e) => ({ a: e.key, b: e.value })));

  return `<form class="conf" x-data="{ ...dbListe(${escape(lignesInit)}), voir: false }"
  hx-post="${base}/env" hx-target="#sortie-${id}" hx-swap="innerHTML">
  <div class="liste">
    <template x-for="(ligne, i) in lignes" :key="ligne.id">
      <div class="var">
        <input class="cle" name="key" x-model="ligne.a" placeholder="CLE" spellcheck="false" autocapitalize="off">
        <input name="value" x-model="ligne.b" placeholder="valeur" spellcheck="false"
          :type="voir ? 'text' : 'password'">
        <button type="button" title="retirer" @click="retirer(i)">×</button>
      </div>
    </template>
  </div>
  <div class="conf-pied">
    <button type="button" @click="ajouter()">Ajouter</button>
    <button type="submit">Enregistrer et appliquer</button>
    <label><input type="checkbox" x-model="voir"> voir les valeurs</label>
  </div>
</form>`;
}

/**
 * Le panneau « Manifeste » : un formulaire HTML simple, aucun champ dynamique
 * — le mode ne se change pas ici (`writeManifestTarget` le refuse), ni le
 * Dockerfile/l'image/le volume — trop structurants pour un formulaire, une
 * modification malvenue peut casser un build ou perdre des données. Seul ce
 * qui se corrige sans risque à chaque redéploiement est éditable ici ; le
 * reste continue de se modifier dans dbox.toml directement.
 */
export function manifestPanelFragment(
  app: string,
  target: string,
  cible: Target,
  cle: { exists: boolean; publicKey: string | null } | null,
): string {
  const id = domId(app, target);
  const base = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}`;

  const champCommande =
    cible.mode !== "deployed"
      ? `<label class="champ">
      <span>commande</span>
      <input name="command" value="${escape(cible.command)}">
    </label>`
      : "";
  const champAuto =
    cible.mode !== "workspace"
      ? `<label class="reglage-auto">
      <input type="checkbox" name="autoDeploy" ${cible.autoDeploy ? "checked" : ""}>
      redéploiement automatique
    </label>`
      : "";

  return `<form class="conf" hx-post="${base}/manifest" hx-target="#sortie-${id}" hx-swap="innerHTML">
  <div class="reglages-champs">
    <label class="champ">
      <span>port</span>
      <input name="port" type="number" min="1" max="65535" value="${cible.port}">
    </label>
    <label class="champ">
      <span>santé</span>
      <input name="health" value="${escape(cible.health)}" placeholder="/">
    </label>
    ${champCommande}
    ${champAuto}
  </div>
  <button type="submit">Enregistrer</button>
  ${cleAppFragment(app, cle)}
</form>`;
}

/** Un message court affiché dans la zone de sortie d'une carte — succès ou
 * échec d'une action ponctuelle (démarrer/arrêter, enregistrer). Recharge la
 * page après un succès qui change l'état affiché par la carte (statut,
 * boutons Démarrer/Arrêter) ; jamais après un échec, ni pour un simple
 * enregistrement qui ne change rien à l'affichage. */
export function actionResult(ok: boolean, detail: string | null, reload: boolean): string {
  const texte = ok ? (detail ?? "fait") : (detail ?? "échec");
  const script = ok && reload ? `<script>setTimeout(() => location.reload(), 600)</script>` : "";
  return `<pre>${escape(texte)}</pre>${script}`;
}

/** Le journal d'une cible, dans le même bloc `<pre>` que les autres messages
 * de sortie — jamais de HTML injecté depuis un journal de conteneur. */
export function logsFragment(text: string): string {
  return `<pre>${escape(text)}</pre>`;
}

export interface JobView {
  id: string;
  status: "en cours" | "réussi" | "échoué";
  lines: string[];
}

/**
 * Le fragment de suivi d'une tâche longue (redéploiement, ajout d'une app) —
 * tant qu'elle tourne, il se repose lui-même toutes les 1,5 s (`hx-trigger`) ;
 * une fois terminée, il ne porte plus l'attribut et htmx cesse de le
 * requêter, sans qu'aucun JS n'ait eu à l'arrêter explicitement.
 */
export function jobFragment(job: JobView): string {
  const lignes = escape(job.lines.join("\n") || "…");
  if (job.status === "en cours") {
    return `<div hx-get="/api/jobs/${job.id}" hx-trigger="every 1500ms" hx-swap="outerHTML"><pre>${lignes}</pre></div>`;
  }
  const script = job.status === "réussi" ? `<script>setTimeout(() => location.reload(), 600)</script>` : "";
  return `<pre>${lignes}</pre>${script}`;
}

function domId(app: string, target: string): string {
  return `${slug(app)}-${slug(target)}`;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
