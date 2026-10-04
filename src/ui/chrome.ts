/**
 * L'habillage de la page : sa feuille de style, son script, ses icônes.
 *
 * Rien ici ne dépend de l'état des apps — c'est le décor, identique d'un
 * rendu à l'autre. htmx et Alpine sont servis par le daemon lui-même
 * (`vendor.ts`), jamais depuis un CDN : la page ne dépend de rien d'externe.
 */

import type { MachineEntry } from "../machines.ts";
import { escape } from "./html.ts";

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

export
const PWA_HEAD = `<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#2f6fed">`;

export
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
/* flex-wrap : sur /settings, « DBox — réglages » plus le sélecteur et
   l'identité dépassaient 375 px, et « ← Retour » sortait de l'écran — mesuré
   à la passe mobile du 4 octobre 2026. */
header { display:flex; align-items:baseline; gap:.6rem; margin-bottom:1.25rem; flex-wrap:wrap; }
h1 { font-size:1.35rem; margin:0; letter-spacing:-.01em; }
.entete-droite { margin-left:auto; display:flex; align-items:center; gap:.7rem; }
.viewer { color:var(--doux); font-size:.85rem; }
.machine-select { font:inherit; font-size:.85rem; padding:.25rem .5rem; border-radius:7px;
  border:1px solid var(--bord); background:var(--fond); color:inherit; }
.reglages { color:var(--doux); font-size:.85rem; text-decoration:none; border-bottom:1px solid var(--bord); }
.resume { color:var(--doux); font-size:.85rem; margin:0 0 .8rem; display:flex;
  gap:.4rem; flex-wrap:wrap; align-items:baseline; }
/* Des boutons, mais qui se lisent comme la phrase qu'ils formaient avant :
   le résumé reste une ligne de texte, pas une barre d'outils. */
.resume .compteur { font:inherit; color:inherit; border:none; background:none;
  padding:0; cursor:pointer; border-bottom:1px dashed var(--bord); border-radius:0; }
.resume .compteur:hover { color:var(--texte); border-bottom-color:currentColor; }
/* Résumé et filtre sur une ligne : empilés, ils mangeaient 85 px avant la
   première carte, sur un écran qui en fait 860. Le display:contents sort la
   boîte de #cartes du flux sans le sortir du DOM — il reste la cible du
   sondage htmx, seuls ses enfants deviennent des éléments de cette ligne. */
.liste-apps { display:flex; flex-wrap:wrap; align-items:center; gap:.7rem; }
.liste-apps > #cartes { display:contents; }
.liste-apps .resume { order:1; margin:0; }
/* margin:0 — sinon la marge basse du champ s'ajoute à l'écart du flex et on
   reperd ce qu'on vient de gagner. min-width serré pour qu'un téléphone de
   430 px ait encore la place de poser le champ à côté du résumé. */
.liste-apps .filtre { order:2; flex:1; min-width:9rem; margin:0; }
.liste-apps .apps, .liste-apps .vide { order:3; flex-basis:100%; }
.filtre { width:100%; font:inherit; font-size:.9rem; padding:.4rem .7rem; margin-bottom:.7rem;
  border:1px solid var(--bord); border-radius:9px; background:var(--fond); color:var(--texte); }
/* La grille porte les **apps**, pas les cartes : au-delà de ~1100px la colonne
   unique laissait les deux tiers de l'écran vides, et auto-fit retombe seul sur
   une colonne en dessous du seuil. Grouper au niveau de la grille garde les
   cibles d'une même app ensemble, au lieu de les laisser tomber dans deux
   rangées différentes au gré du remplissage. */
/* min(34rem, 100%) et pas 34rem : sans le min(), la colonne ne peut pas
   descendre sous 544 px, et un téléphone de 430 px se retrouve avec 130 px de
   contenu hors champ à droite — mesuré, pas supposé. auto-fit ne rétrécit
   jamais en dessous de la borne basse, c'est à elle de céder. */
.apps { display:grid; gap:.7rem; grid-template-columns:repeat(auto-fit, minmax(min(34rem, 100%), 1fr));
  align-items:start; }
ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.45rem; }
/* Le liseré ne se justifie que s'il relie plusieurs cibles ; une app seule
   s'en passe, sinon la carte se retrouve dans une double bordure. */
ul.app-multiple { border-left:2px solid var(--bord); padding-left:.7rem; }
/* Un panneau ouvert déborde de sa colonne : le bloc entier reprend la largeur,
   sinon les champs deviennent illisibles. */
.apps > ul:has(.conf) { grid-column:1 / -1; }
li { border:1px solid var(--bord); border-radius:12px; background:var(--carte);
  padding:.85rem .95rem .85rem 1.2rem; position:relative; overflow:hidden; }
/* L'état se lit sans parcourir les pastilles : un liseré par carte, de la
   couleur exacte de la pastille correspondante. C'est aussi ce qui rend
   visible un compagnon en panne, qui met la cible en « partielle ». */
li::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--bord); }
li.etat-marche::before { background:#1a7f37; }
li.etat-partielle::before, li.etat-redemarre::before { background:#bf5b00; }
.ligne { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
.nom { font-weight:600; }
.cible { color:var(--doux); font-weight:400; }
.etat { font-size:.78rem; padding:.12rem .5rem; border-radius:999px; border:1px solid currentColor; }
.marche { color:#1a7f37; } .arretee { color:var(--doux); } .partielle,.redemarre { color:#bf5b00; }
.jamais { color:var(--doux); }
/* Bleu plutôt que vert/orange : « public » n'est pas un état de santé, c'est
   une portée. Confondre les deux ferait lire « tout va bien » là où il faut
   lire « joignable depuis internet ». */
.publique { color:var(--accent); }
.meta { color:var(--doux); font-size:.85rem; margin-top:.35rem; }
.meta a.commit { color:inherit; text-decoration:none; border-bottom:1px dotted currentColor; }
.meta .retard { color:#bf5b00; }
.rappel a { color:inherit; }
/* align-items, sans quoi une colonne flex étire ses enfants sur toute la
   largeur — et le soulignement du lien avec eux, jusqu'au bord de la carte.
   min-height réserve deux lignes qu'il y ait une URL ou deux : une cible
   publique en porte deux, une cible privée une seule, et les rangées de la
   grille partaient en dents de scie. Réserver la place ici plutôt qu'étirer
   les cartes à la hauteur de la rangée — une app à trois cibles rendrait
   alors toutes ses voisines trois fois trop hautes. */
.urls { display:flex; flex-direction:column; align-items:flex-start; gap:.15rem;
  min-height:2.95rem; }
a.url { display:inline-block; margin-top:.5rem; color:inherit; text-decoration:none;
  border-bottom:1px solid var(--bord); word-break:break-all; }
a.url-publique { color:var(--accent); border-bottom-color:currentColor; }
.actions { display:flex; flex-direction:column; gap:.5rem; margin-top:.75rem; }
.principales, .secondaires { display:flex; gap:.45rem; flex-wrap:wrap; }
button { font:inherit; font-size:.85rem; padding:.35rem .75rem; border-radius:8px; cursor:pointer;
  border:1px solid var(--bord); background:transparent; color:inherit; }
button:active { transform:translateY(1px); }
/* Au doigt, les boutons du journal faisaient 48x25 px à 7 px l'un de l'autre :
   on tapait Pause en visant Fermer. La recommandation est 44x44. On ne
   l'applique qu'au tactile — sur un écran piloté à la souris, des boutons de
   cette taille alourdiraient la page pour rien. */
/* Une seule colonne : les cartes ne s'alignent plus côte à côte, donc plus
   rien à égaliser — la place réservée pour une deuxième URL est perdue pour
   de bon. Même raisonnement pour le https://, que la carte n'a pas besoin
   de montrer pour qu'on sache où l'on va. */
@media (max-width: 40rem) {
  .urls { min-height:0; }
  a.url .schema { display:none; }
  li { padding:.7rem .8rem .7rem 1rem; }
  .actions { gap:.35rem; }
  h1 { font-size:1.2rem; }
  /* Les quatre bascules sur une seule rangée, à parts égales : « Journaux »
     tombait seul sur une deuxième ligne, et la carte grandissait d'autant.
     Une grille minmax(0, 1fr) et pas un flex sans retour à la ligne : celui-ci
     imposait la somme des largeurs de texte comme minimum, et une app à deux
     cibles (retrait à gauche) débordait de 4 px — mesuré au banc d'essai. */
  /* .actions devant : la règle tactile plus bas (pointer: coarse) remettrait
     .6rem d'écart, et les libellés seraient de nouveau tronqués au téléphone. */
  /* Même règle pour les actions : « Redémarrer » tombait seul en dessous. Leur
     nombre varie (2 ou 3), d'où des colonnes créées à la demande. */
  .actions .principales { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0, 1fr); gap:.35rem; }
  .actions .principales button { min-width:0; padding-left:.2rem; padding-right:.2rem;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .actions .secondaires { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:.25rem; }
  .actions .secondaires button { min-width:0; padding-left:.1rem; padding-right:.1rem; font-size:.78rem;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
}
@media (pointer: coarse) {
  button { min-height:2.75rem; padding-left:.9rem; padding-right:.9rem; }
  .principales, .secondaires, .journal-tete, .conf-pied { gap:.6rem; }
  .resume { gap:.75rem; }
  .resume .compteur { min-height:auto; padding:.2rem 0; }
  .var button, .compagnons > button { min-height:2.75rem; }
}
button[disabled], button.htmx-request { opacity:.45; cursor:default; }
/* htmx pose « htmx-request » sur l'émetteur de la requête — pour un
   formulaire, c'est le formulaire lui-même, pas ses boutons ; ce sélecteur
   les atteint quand même, sans avoir à lister chaque bouton un par un. */
form.htmx-request button { opacity:.45; pointer-events:none; }
/* L'action qui fait vraiment quelque chose (redéployer, démarrer/arrêter) se
   distingue des panneaux de détail — le regard va d'abord là, pas dispersé
   sur cinq boutons de poids égal. */
.principales button { font-weight:600; }
/* Sans restriction à .principales : le même bouton reparaît dans le résultat
   d'un enregistrement (« Redéployer maintenant »), et c'est là aussi l'action
   que le message appelle — il doit peser pareil. */
button.redeployer { background:var(--accent); border-color:var(--accent); color:var(--accent-texte);
  font-weight:600; }
/* Une bordure, sinon ces bascules se lisent comme du texte et non comme des
   contrôles — c'est ce que montrait la capture avant retouche. */
/* Texte plein plutôt que gris : en gris clair sur fond clair, ces bascules se
   lisaient mal au soleil, sur un téléphone — c'est pourtant là qu'on s'en sert. */
.secondaires button { border-color:var(--bord); background:var(--fond);
  color:var(--texte); font-size:.82rem; padding:.3rem .6rem; }
.secondaires button:hover { color:var(--texte); }
/* Le panneau ouvert se lit sur son bouton : sans ça, rien ne dit lequel des
   trois on regarde, ni sur lequel recliquer pour refermer. */
.secondaires button.actif { color:var(--texte); border-color:var(--accent);
  background:var(--actif); }
.dangereuses { display:flex; gap:.45rem; flex-wrap:wrap; margin-top:.9rem;
  padding-top:.7rem; border-top:1px solid var(--bord); }
.dangereuses button { border-color:transparent; color:#d4183399; font-size:.8rem; padding:.3rem .6rem; }
.dangereuses button:hover { color:#d41833; }
pre { margin:.65rem 0 0; padding:.6rem; border:1px solid var(--bord); border-radius:8px;
  background:var(--fond); color:var(--doux); font-size:.78rem; line-height:1.45;
  max-height:16rem; overflow:auto; white-space:pre-wrap; word-break:break-word; }
.vide { color:var(--doux); }
.journal { margin-top:.65rem; }
.journal-tete { display:flex; align-items:center; gap:.45rem; font-size:.78rem; color:var(--doux); }
.journal-tete button { font-size:.75rem; padding:.15rem .45rem; }
.journal-tete .pause-btn { margin-left:auto; }
.journal-reglages { display:flex; gap:.45rem; margin-top:.35rem; }
.journal-reglages input, .journal-reglages select { font:inherit; font-size:.8rem; padding:.25rem .5rem;
  border:1px solid var(--bord); border-radius:7px; background:var(--fond); color:var(--texte); }
.journal-reglages input { flex:1; min-width:0; }
/* Le libellé du bouton vient du CSS : l'état « en pause » vit dans une classe,
   pas dans du JS — voir logsFragment dans panneaux.ts. */
.journal .pause-btn::after { content:"Pause"; }
.journal.pause .pause-btn::after { content:"Reprendre"; }
.journal.pause .journal-tete span::after { content:" — en pause"; color:#bf5b00; }
.journal pre { margin-top:.3rem; }
.souci { margin-top:.3rem; font-size:.82rem; color:#bf5b00;
  font-family:ui-monospace,Menlo,Consolas,monospace; }
.suite { margin-top:.5rem; }
.fichiers { margin-top:.7rem; }
.fichiers-infos { display:grid; gap:.25rem; font-size:.82rem; color:var(--doux); margin-bottom:.5rem; }
.fichiers-infos span { color:var(--texte); }
.fichiers-infos code { font-family:ui-monospace,Menlo,Consolas,monospace; word-break:break-all; }
.fichiers details { border-top:1px solid var(--bord); }
.fichiers summary { cursor:pointer; padding:.4rem 0; font-size:.85rem;
  font-family:ui-monospace,Menlo,Consolas,monospace; }
.fichiers details pre { margin:0 0 .5rem; }
.fichiers .note { margin:.5rem 0 0; color:var(--doux); font-size:.78rem; }
.avis { border-radius:12px; padding:.7rem .95rem; margin-bottom:1rem; font-size:.88rem; }
.avis-doux { border:1px solid #bf5b0055; background:#bf5b0012; color:inherit; }
.avis-fort { border:1px solid #d4183355; background:#d4183312; color:inherit; }
.cle-info { color:var(--doux); font-size:.85rem; margin:0 0 1rem; }
/* Les constats rassemblés : sans ce cadre, ils flottaient en texte nu au-dessus
   des panneaux encadrés, sans qu'on sache s'ils formaient un tout ou s'étaient
   échappés du panneau du dessous. Les avis, eux, restent au-dessus et seuls. */
.etat-machine { border:1px solid var(--bord); border-radius:12px; padding:.85rem .95rem .1rem;
  margin-bottom:1rem; }
.etat-machine h2 { font-size:.9rem; margin:0 0 .6rem; }
/* minmax(0, 1fr) et pas la colonne implicite (auto) : celle-ci ne descend pas
   sous la largeur naturelle des champs, et le panneau Variables débordait de
   l'écran d'un téléphone — boutons « × » et case « voir les valeurs » hors
   champ. Mesuré à 469 px pour un écran de 375. */
.conf { margin-top:.7rem; display:grid; gap:.4rem; grid-template-columns:minmax(0, 1fr); }
/* Une grille étire ses enfants : le bouton d'enregistrement faisait toute la
   largeur, sans fond — indiscernable d'un champ de saisie de plus. Il reprend
   la taille de son texte, et le poids de l'action qu'il déclenche. */
.conf > button[type="submit"] { justify-self:start; font-weight:600;
  background:var(--accent); border-color:var(--accent); color:var(--accent-texte); }
.var { display:flex; gap:.35rem; }
.var input { flex:1; min-width:0; font:inherit; font-size:.85rem; padding:.3rem .5rem;
  border:1px solid var(--bord); border-radius:7px; background:var(--fond); color:inherit; }
.var input.cle { flex:0 0 40%; }
.var button { flex:0 0 auto; padding:.3rem .55rem; }
.compagnons { display:grid; gap:.35rem; margin-top:.2rem; }
.compagnons .var input:first-child { flex:0 0 22%; }
.compagnons > button { justify-self:start; }
.titre-champ { font-size:.78rem; color:var(--doux); }
.conf-pied { display:flex; gap:.45rem; align-items:center; flex-wrap:wrap; }
.conf-pied label { color:var(--doux); font-size:.8rem; display:flex; gap:.3rem; align-items:center; }
.reglages-champs { display:flex; gap:.7rem; flex-wrap:wrap; align-items:end; }
/* Un champ étiqueté : le label reste visible une fois le champ rempli — un
   repère qu'un simple placeholder perd dès la première frappe. */
.champ { display:flex; flex-direction:column; gap:.25rem; font-size:.78rem; color:var(--doux);
  flex:1; min-width:8rem; }
/* Sans ça, « données déplace le point de montage » se lit comme un seul
   libellé : l'indice doit peser moins que le nom du champ. */
.champ small, .titre-champ small { font-size:.92em; opacity:.7; font-style:italic; }
.champ input, .champ select { width:100%; font:inherit; font-size:.85rem; padding:.35rem .5rem;
  border:1px solid var(--bord); border-radius:7px; background:var(--fond); color:var(--texte); }
.reglage-auto { display:flex; flex-direction:row; align-items:center; gap:.35rem; font-size:.8rem; color:var(--doux); }
.bloc-ajout { margin-bottom:1rem; }
.apercu { margin-top:.6rem; }
.apercu pre { margin-top:.25rem; }
.apercu .note { margin:.3rem 0 0; color:var(--doux); font-size:.78rem; }
.ajout-bascule { color:var(--doux); font-size:.85rem; border-style:dashed; }
.ajout-bascule:hover { color:var(--texte); }
.ajout { border:1px dashed var(--bord); border-radius:12px; padding:.85rem .95rem;
  margin-top:.6rem; }
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
export
const SCRIPT = `
document.addEventListener("alpine:init", () => {
  // Une liste de paires nom/valeur qu'on édite — le .env d'une cible et les
  // machines connues ont la même forme, ce composant sert aux deux.
  Alpine.data("dbListe", (lignes) => ({
    lignes: lignes.map((l, i) => ({ ...l, id: i })),
    prochainId: lignes.length,
    ajouter() { this.lignes.push({ a: "", b: "", c: "", id: this.prochainId++ }); },
    retirer(i) { this.lignes.splice(i, 1); },
  }));

  // L'état d'une carte : quel panneau elle montre, s'il y en a un. Le panneau
  // lui-même vient du serveur (htmx) ; ce qui vit ici, c'est seulement la
  // bascule — sans elle, un panneau ouvert le restait jusqu'au rechargement de
  // la page, en poussant toutes les cartes suivantes hors de l'écran.
  Alpine.data("dbCarte", (id) => ({
    panneau: null,
    bascule(nom, url) {
      const cible = document.getElementById("panneau-" + id);
      if (!cible) return;
      // Refermer ne demande rien au serveur : la requête ne servirait qu'à
      // remplir un élément qu'on vide dans la foulée.
      if (this.panneau === nom) {
        this.panneau = null;
        cible.innerHTML = "";
        return;
      }
      this.panneau = nom;
      htmx.ajax("GET", url, cible);
    },
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

export
const CLASSES: Record<string, string> = {
  "en marche": "marche",
  arrêtée: "arretee",
  partielle: "partielle",
  redémarre: "redemarre",
  "jamais démarrée": "jamais",
};

/** Chargés localement, jamais depuis un CDN — voir `vendor.ts`. */
export
const VENDOR_SCRIPTS = `<script src="/htmx.js"></script>
<script src="/alpine.js" defer></script>`;

/**
 * Absent quand aucune autre machine n'est connue : pas la peine d'un menu à
 * une seule entrée. La présélection de « celle qu'on regarde » se fait côté
 * client (SCRIPT) — comparer `location.origin` est plus fiable que de faire
 * deviner au serveur sa propre URL publique.
 */
export
function machineSelector(machines: MachineEntry[]): string {
  if (machines.length === 0) return "";

  const options = machines
    .map((m) => `<option value="${escape(m.url)}">${escape(m.name)}</option>`)
    .join("");
  return `<select class="machine-select" aria-label="Changer de machine" onchange="if(this.value && this.value !== location.origin) location.href = this.value">${options}</select>`;
}
