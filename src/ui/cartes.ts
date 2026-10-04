/**
 * La liste des apps déployées, une carte par cible.
 *
 * C'est la vue principale du tableau de bord : ce qui tourne, où, depuis
 * quand, et les actions qu'on peut déclencher dessus.
 */

import type { Entry } from "../registry.ts";
import { since } from "../registry.ts";
import type { VersionInfo } from "../versions.ts";
import { CLASSES } from "./chrome.ts";
import { domId, escape } from "./html.ts";
import { jobFragment, type JobView } from "./panneaux.ts";

/**
 * Ce que le serveur sait d'une cible en plus du registre, indexé par
 * `app/cible` (le même libellé que les tâches de `jobs.ts`).
 *
 * `jobs` : sans lui, recharger la page pendant un redéploiement en perdait le
 * suivi — la tâche continuait côté serveur, la carte n'en montrait plus rien,
 * et ses boutons laissaient cliquer pour se faire refuser.
 */
export interface Extras {
  jobs?: Map<string, JobView>;
  versions?: Map<string, VersionInfo>;
}

export const cleCible = (app: string, target: string): string => `${app}/${target}`;

/**
 * Le fragment servi tel quel par `/api/apps/list` — sondé par htmx (voir
 * `renderPage`) pour garder le tableau de bord à jour sans recharger la page
 * entière, contrairement au formulaire d'ajout qui reste en dehors de #cartes.
 */
export function renderList(entries: Entry[], now: number, actionable: boolean, extras: Extras = {}): string {
  if (entries.length === 0) return `<p class="vide">Aucune cible déployée.</p>`;

  // Les cibles d'une même app se suivent déjà dans l'ordre, mais la grille les
  // jetait dans des colonnes éloignées : `budget · dev` et `budget · prod` ne
  // se lisaient plus comme une paire. Un bloc par app rétablit la parenté ;
  // avec une seule cible — le cas courant — rien ne change à l'œil.
  const parApp = new Map<string, Entry[]>();
  for (const entry of entries) {
    const liste = parApp.get(entry.descriptor.app) ?? [];
    liste.push(entry);
    parApp.set(entry.descriptor.app, liste);
  }

  const blocs = [...parApp.entries()].map(([app, cibles]) => {
    // Le bloc entier disparaît quand aucune de ses cibles ne correspond : sans
    // ça, il garderait sa place dans la grille et le filtre laisserait des
    // trous. Les cartes gardent leur propre `x-show` pour le cas d'une app à
    // plusieurs cibles dont une seule correspond.
    const cherchable = escape(cibles.map((e) => cherche(e)).join(" "));
    const filtrable = actionable ? ` data-cherche="${cherchable}"${X_SHOW}` : "";
    return (
      `<ul class="app${cibles.length > 1 ? " app-multiple" : ""}"${filtrable}>` +
      cibles.map((entry) => card(entry, now, actionable, extras)).join("") +
      `</ul>`
    );
  });

  return `${resume(entries, actionable)}<div class="apps">${blocs.join("")}</div>`;
}

/**
 * Le filtre est **entièrement conditionné à `actionable`** : sans les actions,
 * la page ne charge ni htmx ni Alpine (voir `renderPage`), et un `x-cloak`
 * qu'aucun Alpine ne vient retirer garde `display:none` — la liste entière
 * disparaîtrait. Un lecteur seul retrouve donc la liste nue.
 */
const X_SHOW = ` x-show="!q || $el.dataset.cherche.includes(q.toLowerCase())" x-cloak`;

/**
 * Ce qu'on veut savoir avant de lire les cartes une par une : combien tournent,
 * combien sont à l'arrêt, combien sont exposées. Calculé depuis les entrées
 * déjà chargées — aucun appel de plus.
 */
function resume(entries: Entry[], actionable: boolean): string {
  const marche = entries.filter((e) => e.status === "en marche").length;
  const soucis = entries.filter((e) => e.status === "partielle" || e.status === "redémarre").length;
  const publiques = entries.filter((e) => e.descriptor.publicDomain !== null).length;

  // Chaque compteur pose le filtre correspondant : « 1 en souffrance » sans
  // moyen d'atteindre la carte concernée obligeait à faire défiler dix cartes
  // pour trouver laquelle. Les jetons visés sont ceux que `cherche()` ajoute au
  // texte cherchable, pas des mots inventés ici.
  const compteur = (n: number, texte: string, jeton: string, fort = false): string => {
    const dedans = fort ? `<strong>${n} ${texte}</strong>` : `${n} ${texte}`;
    if (!actionable) return `<span class="compteur-inerte">${dedans}</span>`;
    return `<button type="button" class="compteur" @click="q = q === '${jeton}' ? '' : '${jeton}'"
      :aria-pressed="q === '${jeton}' ? 'true' : 'false'">${dedans}</button>`;
  };

  const morceaux = [
    compteur(entries.length, `cible${entries.length > 1 ? "s" : ""}`, ""),
    compteur(marche, "en marche", "en marche"),
  ];
  if (soucis > 0) morceaux.push(compteur(soucis, "en souffrance", "souci", true));
  if (publiques > 0) morceaux.push(compteur(publiques, `publique${publiques > 1 ? "s" : ""}`, "public"));

  return `<p class="resume">${morceaux.join(" · ")}</p>`;
}

/**
 * `dbox-budget-prod-tailscale-1` ne dit rien de plus que `tailscale` sur une
 * carte qui porte déjà le nom de l'app et de la cible. On retire le préfixe du
 * projet et le suffixe de réplique de Compose ; si le nom ne suit pas cette
 * forme (un `container_name` posé à la main un jour), on le laisse entier
 * plutôt que de le tronquer au hasard.
 */
function nomCourt(name: string, project: string): string {
  const sans = name.startsWith(`${project}-`) ? name.slice(project.length + 1) : name;
  return sans.replace(/-\d+$/, "");
}

/**
 * Ce sur quoi porte le filtre : ce qu'on tape (nom, cible, domaine, état) et
 * deux jetons qu'on ne tape pas — `public` et `souci` — sur lesquels les
 * compteurs du résumé s'appuient pour être cliquables. « en souffrance »
 * recouvre deux états distincts (`partielle` et `redémarre`) : un seul mot ne
 * les atteindrait pas tous les deux, d'où le jeton.
 */
function cherche(entry: Entry): string {
  const d = entry.descriptor;
  const jetons = [d.app, d.target, d.publicDomain ?? "", entry.status];
  if (d.publicDomain !== null) jetons.push("public");
  if (entry.status === "partielle" || entry.status === "redémarre") jetons.push("souci");
  return jetons.join(" ").toLowerCase();
}

function card(entry: Entry, now: number, actionable: boolean, extras: Extras): string {
  const { descriptor: d, state, status } = entry;
  const cle = cleCible(d.app, d.target);
  const info = extras.versions?.get(cle);
  const job = extras.jobs?.get(cle);
  // Le SHA seul ne dit ni où le lire ni s'il est encore le dernier : un lien
  // vers le commit sur la forge, quand l'adresse du dépôt s'y prête.
  const tag =
    state === null
      ? ""
      : info?.commitUrl
        ? `<a class="commit" href="${escape(info.commitUrl)}">${escape(state.tag)}</a>`
        : escape(state.tag);
  const version = state === null ? "jamais déployée" : `${tag} · ${since(state.deployedAt, now)}`;
  const id = domId(d.app, d.target);

  // « Joignable depuis internet » est l'information la plus lourde de
  // conséquences qu'une carte puisse porter : elle a sa propre pastille, pas
  // une mention noyée dans la ligne de métadonnées.
  const publique =
    d.publicDomain === null
      ? ""
      : `<span class="etat publique" title="exposée sur internet">public</span>`;

  // Le reste complète la ligne grise : ce qui tourne à côté de l'app, et si
  // elle se redéploie toute seule. Sans ça, une cible avec une base ressemble
  // trait pour trait à une cible sans.
  const details = [version, escape(d.mode)];
  if (d.services.length > 0) details.push(`+ ${d.services.map(escape).join(", ")}`);
  if (d.autoDeploy) details.push("auto");
  // Comparé au HEAD local de la source, jamais à l'amont (voir versions.ts) :
  // c'est « j'ai commité, je n'ai pas redéployé », pas « la forge a avancé ».
  if (info?.nonDeployes !== null && info?.nonDeployes !== undefined && info.nonDeployes > 0) {
    const n = info.nonDeployes;
    details.push(`<span class="retard">source : ${n} commit${n > 1 ? "s" : ""} non déployé${n > 1 ? "s" : ""}</span>`);
  }

  // « partielle » ou « redémarre » ne dit pas *quoi* : avec un compagnon, la
  // carte laissait ouvrir les journaux rien que pour apprendre lequel des
  // trois conteneurs manquait. Le registre porte déjà les noms et les états.
  const fautifs = entry.containers.filter((c) => c.state !== "running");
  const souci =
    (status === "partielle" || status === "redémarre") && fautifs.length > 0
      ? `<div class="souci">${fautifs.map((c) => `${escape(nomCourt(c.name, d.project))} : ${escape(c.state)}`).join(" · ")}</div>`
      : "";

  // Le `https://` est enveloppé plutôt que retiré : sur écran étroit la CSS le
  // masque (la carte n'a pas besoin de le montrer pour qu'on sache où l'on
  // va), mais le lien reste entier — copier l'adresse donne toujours une URL
  // valide, et le texte sélectionné aussi.
  const lien = (href: string, classe: string): string => {
    const sans = href.replace(/^https:\/\//, "");
    return `<a class="${classe}" href="${escape(href)}"><span class="schema">https://</span>${escape(sans)}</a>`;
  };

  const urls = [lien(d.url, "url")];
  if (d.publicDomain !== null) urls.push(lien(`https://${d.publicDomain}`, "url url-publique"));

  // Le texte cherchable passe par un attribut de données, jamais directement
  // dans l'expression Alpine : celle-ci est évaluée comme du JavaScript, et une
  // apostrophe dans un nom y ouvrirait une injection. Les noms sont bien
  // validés comme labels DNS ailleurs, mais une garantie de rendu ne doit pas
  // dépendre d'une validation lointaine.
  const cherchable = escape(cherche(entry));

  // La classe d'état porte aussi le liseré de gauche : l'état se lit alors d'un
  // coup d'œil sur une liste, sans parcourir chaque pastille. C'est ce qui rend
  // visible un compagnon en panne, qui met la cible en « partielle ».
  const filtrable = actionable ? ` x-data="dbCarte('${id}')" data-cherche="${cherchable}"${X_SHOW}` : "";

  return `<li id="carte-${id}" class="etat-${CLASSES[status] ?? "jamais"}"${filtrable}>
  <div class="ligne">
    <span class="nom">${escape(d.app)} <span class="cible">· ${escape(d.target)}</span></span>
    <span class="etat ${CLASSES[status] ?? ""}">${escape(status)}</span>
    ${publique}
  </div>
  <div class="meta">${details.join(" · ")}</div>
  ${souci}
  <div class="urls">${urls.join("")}</div>
  ${actionable ? buttons(d.app, d.target, status, d.mode, job !== undefined) : ""}
  ${actionable ? `<div id="panneau-${id}"></div><div id="sortie-${id}" role="status" aria-live="polite">${job === undefined ? "" : jobFragment(job)}</div>` : ""}
</li>`;
}

function buttons(app: string, target: string, status: string, mode: string, occupee: boolean): string {
  const running = status === "en marche" || status === "partielle" || status === "redémarre";
  const id = domId(app, target);
  const base = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}`;

  // Couper une cible déployée coupe ce que d'autres utilisent : une
  // confirmation, comme « Supprimer ». Au téléphone, « Arrêter » est à un
  // glissement de doigt de « Redéployer ». Une cible de dev reste sans
  // friction — on l'arrête et la relance vingt fois par jour.
  const confirme = (verbe: string) =>
    mode === "deployed"
      ? ` hx-confirm="${escape(`${verbe} ${app}/${target} ? La cible ne répondra plus le temps de l'opération.`)}"`
      : "";
  // Pendant un redéploiement, le serveur refuserait de toute façon : les
  // boutons d'action le disent d'avance plutôt que de laisser cliquer.
  const pris = occupee ? ` disabled title="redéploiement en cours"` : "";

  // Ce qui agit sur la cible d'un côté (principales), ce qui donne à voir de
  // l'autre (secondaires) — deux poids visuels différents, pas cinq boutons
  // à égalité où l'œil ne sait pas où se poser.
  const principales = [
    `<button class="redeployer" hx-post="${base}/up" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this"${pris}>Redéployer</button>`,
    running
      ? `<button hx-post="${base}/stop" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this"${confirme("Arrêter")}${pris}>Arrêter</button>`
      : `<button hx-post="${base}/start" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this"${pris}>Démarrer</button>`,
    // Seulement quand quelque chose tourne : redémarrer une cible à l'arrêt
    // ne veut rien dire, et `docker compose restart` n'y démarrerait rien.
    // C'est le geste qu'on veut quand un conteneur s'est mis de travers sans
    // qu'aucune configuration n'ait changé — sinon il fallait arrêter, puis
    // démarrer, deux allers-retours pour une seule intention.
    running
      ? `<button hx-post="${base}/restart" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this"${confirme("Redémarrer")}${pris}>Redémarrer</button>`
      : "",
  ].join("");

  // Des bascules, pas des ouvertures : cliquer deux fois referme. La requête
  // part depuis Alpine (`dbCarte`) plutôt que par `hx-get`, pour que la
  // fermeture ne demande rien au serveur.
  //
  // L'action et l'URL passent par des attributs `data-*`, jamais dans
  // l'expression Alpine elle-même : celle-ci est du JavaScript, et
  // `encodeURIComponent` ne l'en protège PAS — il laisse passer `'`, `(`, `)`,
  // `-`, de quoi écrire `x')-alert(1)-('` dans un nom d'app. Une version
  // précédente le croyait, à tort ; la page exécutait le code injecté. Dans un
  // attribut échappé, la valeur reste une donnée, quelle qu'elle soit.
  const secondaires = [
    ["env", "Variables"],
    ["manifest", "Manifeste"],
    ["fichiers", "Fichiers"],
  ]
    .map(
      ([action, label]) =>
        `<button data-action="${action}" data-url="${escape(`${base}/${action}`)}"
        aria-controls="panneau-${id}"
        @click="bascule($el.dataset.action, $el.dataset.url)"
        :class="{ actif: panneau === $el.dataset.action }"
        :aria-pressed="panneau === $el.dataset.action ? 'true' : 'false'">${label}</button>`,
    )
    .join("") +
    `<button hx-get="${base}/logs?lines=200" hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this"
      aria-controls="sortie-${id}">Journaux</button>`;

  // « Supprimer » n'est plus ici : il vit dans le panneau Manifeste, à côté de
  // la configuration qu'il détruit. Dix cartes, c'était dix boutons rouges
  // irréversibles à un clic de distance sur la surface toujours visible — dix
  // occasions de se tromper, pour un geste qu'on ne fait presque jamais.
  return `<div class="actions">
    <div class="principales">${principales}</div>
    <div class="secondaires">${secondaires}</div>
  </div>`;
}
