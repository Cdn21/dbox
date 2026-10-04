/**
 * Le formulaire d'ajout d'une app — dépôt git, ou dossier déjà présent sur la
 * machine quand une racine de travail est configurée.
 */

import type { Apercu } from "../actions.ts";
import { escape } from "./html.ts";

/**
 * Le `dbox.toml` que l'ajout écrira, montré avant de cliquer — rejoint le
 * principe « chaque fichier généré est une documentation de ce que DBox a
 * compris », mais avant qu'il soit trop tard pour corriger le formulaire.
 */
export function apercuFragment(apercu: Apercu): string {
  const contenu = apercu.contenu === null ? "" : `<pre>${escape(apercu.contenu)}</pre>`;
  return `<div class="titre-champ">dbox.toml</div>${contenu}<p class="note">${escape(apercu.note)}</p>`;
}

/**
 * Le formulaire d'ajout, en formulaire HTML natif : htmx sérialise les champs
 * nommés tout seul, pas besoin de les relire à la main en JS. Alpine gère le
 * seul état purement local — quels champs montrer selon la source et le mode
 * choisis, jamais envoyé au serveur tel quel.
 */
export function renderAjout(
  workspacesRoot: string | null,
  workspaceProjects: { name: string; command: string | null }[],
  ouvertParDefaut = false,
): string {
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
      <select name="source" x-model="source">
        <option value="git">Dépôt git</option>
        <option value="local">Dossier local</option>
      </select>
    </label>`;

  // Replié par défaut : ajouter une app est rare, regarder l'état est constant
  // — et cinq champs en haut de page repoussaient les cartes hors du premier
  // écran, sur téléphone surtout. Ouvert d'office quand il n'y a encore rien à
  // regarder : c'est alors le seul geste possible, le cacher serait absurde.
  return `<div class="bloc-ajout" x-data="{ ouvert: ${ouvertParDefaut} }">
  <button type="button" class="ajout-bascule" @click="ouvert = !ouvert"
    :aria-expanded="ouvert ? 'true' : 'false'">
    <span x-text="ouvert ? '×' : '+'"></span> Ajouter une app
  </button>
  <form
  class="ajout"
  x-show="ouvert" x-cloak
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
  <div class="ligne" x-show="mode === 'devcontainer'" x-cloak>
    <label class="champ">
      <span>Image</span>
      <input name="image" placeholder="node:24-bookworm-slim" spellcheck="false" autocapitalize="off">
    </label>
    <label class="champ">
      <span>Dockerfile — prime sur l'image</span>
      <input name="dockerfile" placeholder="Dockerfile.dev" spellcheck="false" autocapitalize="off">
    </label>
  </div>
  <!-- hx-target="this" : sinon le bloc hérite du hx-target du formulaire
       (#sortie-ajout) et l'aperçu atterrit dans la zone des résultats.
       « input » et non « keyup changed » : avec from:, « changed » compare la
       valeur du formulaire, qui n'en a pas — la saisie ne déclenchait rien.
       « load » et non « intersect » : un onglet en arrière-plan ne voit
       jamais l'intersection. Vus tous les trois au banc d'essai. -->
  <div class="apercu" hx-get="/api/apps/apercu" hx-include="closest form" hx-target="this" hx-swap="innerHTML"
    hx-trigger="load, change from:closest form, input delay:500ms from:closest form"></div>
  <div id="sortie-ajout" role="status" aria-live="polite"></div>
</form>
</div>`;
}
