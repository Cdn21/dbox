/**
 * La page d'accueil — elle n'assemble que : l'en-tête, le formulaire d'ajout,
 * et la liste des cartes.
 */

import type { AuthkeyNotice } from "../authkey.ts";
import type { MachineEntry } from "../machines.ts";
import type { OrphansReport } from "../orphans-report.ts";
import type { Entry } from "../registry.ts";
import type { TagReport } from "../tag-report.ts";
import { renderAjout } from "./ajout.ts";
import { machineSelector, PWA_HEAD, SCRIPT, STYLE, VENDOR_SCRIPTS } from "./chrome.ts";
import { renderList, type Extras } from "./cartes.ts";
import { escape } from "./html.ts";
import { authkeyBanner, authkeyItems } from "./reglages.ts";

/**
 * En dessous de ce nombre de cibles, pas de champ de filtre : il coûterait
 * 51 px en haut d'un écran de téléphone pour trier une liste qui tient déjà
 * dedans. Le résumé, lui, reste toujours affiché — il ne coûte qu'une ligne.
 */
const SEUIL_FILTRE = 5;

/**
 * Les rapports du rotator ne vivaient que sur /settings — une page qu'on
 * n'ouvre presque jamais. L'accueil, lui, est ouvert tous les jours : il
 * porte une ligne de rappel quand l'un d'eux appelle un geste, et renvoie vers
 * les Réglages pour le détail. Rien quand tout va bien : une alerte toujours
 * présente cesse d'être lue.
 */
export interface Rapports {
  orphans?: OrphansReport | null;
  tag?: TagReport | null;
}

function rappels(rapports: Rapports): string {
  const lignes: string[] = [];
  const n = rapports.orphans?.stale.length ?? 0;
  if (n > 0) {
    lignes.push(`${n} nœud${n > 1 ? "s" : ""} Tailscale sans connexion depuis plus de 14 jours`);
  }
  if (rapports.tag != null && !rapports.tag.present) {
    lignes.push(`le tag ${escape(rapports.tag.tag)} manque dans tagOwners — un ajout d'app échouerait`);
  }
  if (lignes.length === 0) return "";
  return `<div class="avis avis-doux rappel">${lignes.join(" · ")} — <a href="/settings">voir les Réglages</a></div>`;
}

/** Ce qui, ouvert dans une carte, suspend le sondage de la liste. */
const GARDES = ["#cartes .conf", "#cartes .fichiers", "#cartes .journal", "#cartes .job"].join(", ");

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
  extras: Extras = {},
  rapports: Rapports = {},
  headscaleAuthkeyNotice: AuthkeyNotice | null = null,
): string {
  // htmx se sonde lui-même : le formulaire d'ajout reste en dehors de #cartes,
  // jamais retouché par le sondage. Mais le sondage remplace **toutes** les
  // cartes, donc tout ce qu'elles montrent — panneaux et sorties compris.
  //
  // D'où GARDES : la liste de ce qui, ouvert dans une carte, suspend le
  // rafraîchissement. La règle est « ce qui serait détruit et qu'on ne
  // saurait pas reconstruire » : une édition en cours (.conf), un panneau
  // qu'on est en train de lire (.fichiers), un journal qui se suit tout seul
  // (.journal), un redéploiement dont on regarde la progression (.job). Un
  // simple message de résultat, lui, reste jetable — il se relit d'un coup
  // d'œil, et le figer suspendrait le tableau de bord pour rien.
  // Deux déclencheurs, la même garde : toutes les 15 s, et **au retour sur
  // l'onglet** — le sondage est suspendu tant qu'il est caché, et sans ce
  // second déclencheur on revenait sur un état vieux de jusqu'à 15 s.
  const garde = `!document.hidden && !document.querySelector('.htmx-request') && !document.querySelector('${GARDES}')`;
  const sondage = actionable
    ? ` hx-get="/api/apps/list" hx-trigger="every 15s [${garde}], visibilitychange[${garde}] from:document" hx-swap="innerHTML"`
    : "";
  // L'état du filtre vit **au-dessus** de #cartes : le sondage htmx n'en
  // remplace que l'intérieur, donc la saisie survit à chaque rafraîchissement.
  // Alpine ré-initialise les cartes échangées, qui retrouvent `q` en remontant
  // la portée. Sans conteneur d'apps, pas de champ — il n'y aurait rien à
  // filtrer.
  // Conditionné à `actionable` comme le reste du filtre : sans Alpine, ce
  // champ ne ferait rien (voir `X_SHOW` dans cartes.ts). Et seulement au-delà
  // d'un seuil : à quatre cibles on les voit toutes d'un coup d'œil, le champ
  // ne ferait que repousser les cartes hors du premier écran.
  const filtre =
    entries.length < SEUIL_FILTRE || !actionable
      ? ""
      : `<input class="filtre" type="search" x-model="q" placeholder="Filtrer : nom, cible, domaine…"
      spellcheck="false" autocapitalize="off" aria-label="Filtrer les cibles">`;

  const liste = `<div id="cartes"${sondage}>${renderList(entries, now, actionable, extras)}</div>`;
  // Pas de portée Alpine sans Alpine : en lecture seule elle n'aurait porté
  // aucun `x-model` ni `x-show`, juste un div de plus.
  //
  // Le résumé vit *dans* #cartes (il se recalcule à chaque sondage) et le
  // filtre *en dehors* (sinon la saisie serait écrasée toutes les 15 s) : ils
  // ne peuvent pas partager un conteneur sans déplacer cette frontière.
  // `display:contents` sur #cartes (voir la CSS) les remet dans le même flux
  // sans y toucher — le div reste la cible du sondage, il cesse seulement de
  // dessiner une boîte.
  const cartes = actionable ? `<div class="liste-apps" x-data="{ q: '' }">${filtre}${liste}</div>` : liste;

  const ajout = actionable ? renderAjout(workspacesRoot, workspaceProjects, entries.length === 0) : "";

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
${authkeyBanner(authkeyItems(authkeyNotice, adminAuthkeyNotice, headscaleAuthkeyNotice))}
${actionable ? rappels(rapports) : ""}
${ajout}
${cartes}
${actionable ? `${VENDOR_SCRIPTS}\n<script>${SCRIPT}</script>` : ""}
</body>
</html>
`;
}
