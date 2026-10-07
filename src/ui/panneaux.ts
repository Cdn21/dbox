/**
 * Les panneaux dépliables d'une carte, et les fragments courts que les actions
 * renvoient.
 *
 * Tous rendus côté serveur : htmx les pose dans la page telle qu'elle est,
 * sans que le client ait à savoir les construire.
 */

import type { Target } from "../manifest.ts";
import { domId, escape } from "./html.ts";

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
  // Absent en mode workspace, comme dans le manifeste : sans conteneur d'app,
  // il n'y a rien sur quoi Traefik pourrait router.
  const champPublic =
    cible.mode !== "workspace"
      ? `<label class="champ">
      <span>domaine public</span>
      <input name="publicDomain" value="${escape(cible.publicDomain ?? "")}" placeholder="app.exemple.fr"
        spellcheck="false" autocapitalize="off">
    </label>`
      : "";

  // Le volume nommé ne change pas quand ce chemin change : c'est le point de
  // montage qui bouge. Rien n'est perdu, mais l'app ne trouve plus ses données
  // là où elle les cherche — d'où l'avertissement plutôt qu'un champ nu.
  const champData =
    cible.mode !== "workspace"
      ? `<label class="champ">
      <span>données <small>déplace le point de montage, pas le volume</small></span>
      <input name="data" value="${escape(cible.data ?? "")}" placeholder="/var/lib/app"
        spellcheck="false" autocapitalize="off">
    </label>`
      : "";

  // Un devcontainer choisit son environnement : une image toute faite, ou son
  // propre Dockerfile dès que le projet mêle deux runtimes.
  const champEnv =
    cible.mode === "devcontainer"
      ? `<label class="champ">
      <span>image</span>
      <input name="image" value="${escape(cible.image)}" spellcheck="false" autocapitalize="off">
    </label>
    <label class="champ">
      <span>dockerfile <small>prime sur l'image</small></span>
      <input name="dockerfile" value="${escape(cible.dockerfile ?? "")}" placeholder="Dockerfile.dev"
        spellcheck="false" autocapitalize="off">
    </label>`
      : "";

  // Longtemps absent d'ici, et pour une bonne raison : le tag doit déjà exister
  // dans `tagOwners` de la policy du tailnet, sinon le sidecar échoue à
  // s'enregistrer — et DBox ne peut pas le vérifier pour un tag par cible (le
  // rapport de /settings ne couvre que celui de la machine). La mise en garde
  // vaut mieux que d'obliger à éditer le fichier à la main.
  const champTag = `<label class="champ">
      <span>tag ACL <small>doit déjà exister dans tagOwners</small></span>
      <input name="tsTag" value="${escape(cible.tsTag ?? "")}" placeholder="tag:dbox"
        spellcheck="false" autocapitalize="off">
    </label>`;

  // Le backend d'exposition de cette cible : défaut machine, Tailscale, ou
  // Headscale. « headscale » demande les réglages machine (voir /settings) et
  // refuse ssh_port — le serveur re-valide, le select n'est qu'un raccourci.
  const opt = (v: string, label: string) =>
    `<option value="${v}"${(cible.backend ?? "") === v ? " selected" : ""}>${label}</option>`;
  const champBackend = `<label class="champ">
      <span>backend <small>défaut machine sinon</small></span>
      <select name="backend">
        ${opt("", "— défaut machine —")}
        ${opt("tailscale", "tailscale")}
        ${opt("headscale", "headscale")}
      </select>
    </label>`;

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
    ${champEnv}
    ${champData}
    ${champTag}
    ${champBackend}
    ${champAuto}
    ${champPublic}
  </div>
  ${compagnonsFragment(cible)}
  <button type="submit">Enregistrer</button>
  ${cleAppFragment(app, cle)}
</form>
${suppressionFragment(app, target)}`;
}

/**
 * « Supprimer », en dehors du formulaire — jamais dedans : un `<button>` sans
 * `type` y vaut `submit`, et le navigateur enverrait le formulaire en même
 * temps que htmx enverrait la suppression.
 *
 * Sa place ici plutôt que sur la carte : c'est le geste qui détruit la
 * configuration qu'on vient de lire, et il demande d'ouvrir un panneau avant
 * d'être à portée de clic. La confirmation du navigateur (`hx-confirm`) reste.
 */
function suppressionFragment(app: string, target: string): string {
  const id = domId(app, target);
  const base = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}`;
  return `<div class="dangereuses"><button class="supprimer" hx-post="${base}/remove"
    hx-target="#sortie-${id}" hx-swap="innerHTML"
    hx-confirm="Supprimer définitivement ${escape(app)}/${escape(target)} ? Le dossier source et les volumes de données ne sont pas touchés."
    hx-disabled-elt="this">Supprimer</button></div>`;
}

/**
 * Les services compagnons, en liste répétable — même helper Alpine (`dbListe`)
 * que les variables d'environnement et les machines connues, donc même geste
 * pour l'utilisateur : ajouter une ligne, la retirer, enregistrer.
 *
 * Absent en mode `workspace`, comme dans le manifeste : sans conteneur d'app,
 * un compagnon sur le réseau interne serait injoignable.
 */
function compagnonsFragment(cible: Target): string {
  if (cible.mode === "workspace") return "";

  const lignes = Object.entries(cible.services).map(([nom, service]) => ({
    a: nom,
    b: service.image,
    c: service.data ?? "",
  }));

  return `<div class="compagnons" x-data="dbListe(${escape(JSON.stringify(lignes))})">
    <span class="titre-champ">services compagnons <small>une base, un cache — jamais exposés</small></span>
    <template x-for="(ligne, i) in lignes" :key="ligne.id">
      <div class="var">
        <input name="serviceNom" x-model="ligne.a" placeholder="db" spellcheck="false" autocapitalize="off">
        <input name="serviceImage" x-model="ligne.b" placeholder="postgres:16-alpine" spellcheck="false" autocapitalize="off">
        <input name="serviceData" x-model="ligne.c" placeholder="données (optionnel)" spellcheck="false" autocapitalize="off">
        <button type="button" title="retirer" @click="retirer(i)">×</button>
      </div>
    </template>
    <button type="button" @click="ajouter()">Ajouter un service</button>
  </div>`;
}

/**
 * Le panneau « Fichiers » : ce que DBox a déduit du manifeste, tel quel.
 *
 * C'est ce qu'on veut lire quand ça ne marche pas — la carte montre l'entrée
 * (le manifeste) et le résultat (les journaux), jamais ce qu'il y a entre les
 * deux. S'y ajoutent les deux informations que le registre porte déjà sans
 * jamais les montrer : d'où vient le code, et vers quelle version un retour
 * arrière ramènerait.
 *
 * **Limite assumée** : c'est la sortie du *dernier* déploiement. Si le
 * manifeste a changé depuis, ces fichiers ne disent pas ce que produirait un
 * `up` maintenant — d'où la mention en pied de panneau.
 */
export function fichiersPanelFragment(
  source: string,
  previousTag: string | null,
  fichiers: { name: string; content: string }[],
): string {
  const infos = [`<div><span>source</span> <code>${escape(source)}</code></div>`];
  if (previousTag !== null) {
    infos.push(`<div><span>version précédente</span> <code>${escape(previousTag)}</code> <small>ce vers quoi un retour arrière ramènerait</small></div>`);
  }

  if (fichiers.length === 0) {
    return `<div class="fichiers"><div class="fichiers-infos">${infos.join("")}</div>
  <p class="vide">Aucun fichier généré sur le disque — cette cible n'a jamais été déployée.</p></div>`;
  }

  // Repliés par défaut, le premier ouvert : trois blocs dépliés d'un coup
  // repousseraient les cartes suivantes hors de l'écran.
  const blocs = fichiers.map(
    (f, i) => `<details${i === 0 ? " open" : ""}>
    <summary>${escape(f.name)}</summary>
    <pre>${escape(f.content)}</pre>
  </details>`,
  );

  return `<div class="fichiers">
  <div class="fichiers-infos">${infos.join("")}</div>
  ${blocs.join("")}
  <p class="note">Sortie du dernier déploiement — pas de ce que produirait un redéploiement maintenant.</p>
</div>`;
}

/** Un message court affiché dans la zone de sortie d'une carte — succès ou
 * échec d'une action ponctuelle (démarrer/arrêter, enregistrer). Recharge la
 * page après un succès qui change l'état affiché par la carte (statut,
 * boutons Démarrer/Arrêter) ; jamais après un échec, ni pour un simple
 * enregistrement qui ne change rien à l'affichage.
 *
 * `suite` porte le geste que le message appelle — typiquement le bouton de
 * redéploiement après un enregistrement qui ne s'applique qu'au prochain
 * déploiement. Un message qui décrit un manque sans offrir ce qui le comble
 * oblige à refermer le panneau pour aller cliquer deux lignes plus haut. */
export function actionResult(ok: boolean, detail: string | null, reload: boolean, suite = ""): string {
  const texte = ok ? (detail ?? "fait") : (detail ?? "échec");
  const script = ok && reload ? `<script>setTimeout(() => location.reload(), 600)</script>` : "";
  return `<pre>${escape(texte)}</pre>${suite}${script}`;
}

/**
 * Le bouton qui applique tout de suite ce qui vient d'être enregistré. Vise la
 * même zone de sortie que le message dont il fait suite : il s'y remplace par
 * le suivi de la tâche, exactement comme le bouton de la carte.
 */
export function redeployerMaintenant(app: string, target: string): string {
  const id = domId(app, target);
  const base = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}`;
  return `<div class="suite"><button class="redeployer" hx-post="${base}/up"
    hx-target="#sortie-${id}" hx-swap="innerHTML" hx-disabled-elt="this">Redéployer maintenant</button></div>`;
}

/**
 * Le journal d'une cible, dans le même bloc `<pre>` que les autres messages de
 * sortie — jamais de HTML injecté depuis un journal de conteneur.
 *
 * Il se repose lui-même toutes les 3 s : sans ça on obtenait un instantané, et
 * suivre un démarrage demandait de recliquer « Journaux » en boucle. Même
 * mécanique que `jobFragment` — le fragment se remplace, et cesse dès qu'il
 * disparaît de la page.
 *
 * La pause passe par une classe plutôt que par de l'état Alpine : le fragment
 * est remplacé en entier à chaque passage, un état Alpine y serait remis à
 * zéro. En pause, aucun échange n'a lieu, donc la classe survit — c'est ce qui
 * rend l'astuce correcte et pas seulement économe.
 *
 * **Le défilement suit la queue.** `docker compose logs` rend l'ancien en
 * premier : un bloc neuf s'ouvre donc en haut des 200 lignes, sur les plus
 * vieilles, et repartait en haut à chaque passage — les lignes qui viennent
 * d'arriver restaient hors de vue. Le petit script recolle le bloc au bas
 * après chaque échange, comme `tail -f`. Pour relire tranquillement, il y a
 * Pause : plus aucun échange, donc plus aucun saut.
 *
 * « Fermer » vide le conteneur au lieu de retirer ce bloc-ci : le bloc est
 * remplacé toutes les 3 s, donc celui qu'on a sous le doigt peut déjà être
 * détaché au moment du clic — le retirer ne ferait alors rien de visible. Le
 * conteneur, lui, ne bouge jamais.
 *
 * **Le filtre et le nombre de lignes voyagent avec chaque requête** (champs
 * nommés `q` et `lines`, inclus par `hx-include`) et le serveur filtre : un
 * filtre appliqué côté page serait perdu à chaque remplacement du bloc, soit
 * toutes les 3 s. Le champ texte porte `hx-preserve` — htmx le garde tel quel
 * d'un remplacement à l'autre, curseur et saisie compris.
 */
export const LIGNES_JOURNAL = [200, 1000] as const;

export function logsFragment(app: string, target: string, lines: number, text: string, filtre = ""): string {
  const id = domId(app, target);
  const url = `/api/apps/${encodeURIComponent(app)}/${encodeURIComponent(target)}/logs`;
  const condition = `!document.hidden && !document.getElementById('journal-${id}').classList.contains('pause')`;
  // La valeur en cours fait toujours partie des choix : c'est le menu qui la
  // renvoie à chaque passage, et une valeur absente (`?lines=50` tapé à la
  // main) retomberait sinon sur la première option dès le passage suivant.
  const choix = [...new Set([...LIGNES_JOURNAL, lines])].sort((a, b) => a - b);
  const options = choix.map(
    (n) => `<option value="${n}"${n === lines ? " selected" : ""}>${n} lignes</option>`,
  ).join("");
  const vide = filtre !== "" && text.trim() === "" ? `aucune ligne ne contient « ${filtre} »` : text;
  // Même mécanique que `actionResult` : htmx évalue les scripts du fragment
  // qu'il vient de poser. `id` est un slug (lettres, chiffres, tirets), il ne
  // peut pas refermer la chaîne.
  const colle = `<script>(() => { const p = document.querySelector('#journal-${id} pre'); if (p) p.scrollTop = p.scrollHeight; })()</script>`;

  return `<div class="journal" id="journal-${id}"
  hx-get="${url}" hx-trigger="every 3s [${condition}]" hx-swap="outerHTML" hx-include="#journal-${id} .journal-reglages">
  <div class="journal-tete">
    <span>suivi en direct${filtre === "" ? "" : ` · filtré`}</span>
    <button type="button" class="pause-btn"
      @click="$el.closest('.journal').classList.toggle('pause')"></button>
    <button type="button" @click="document.getElementById('sortie-${id}').innerHTML = ''">Fermer</button>
  </div>
  <div class="journal-reglages">
    <input type="search" name="q" id="filtre-journal-${id}" hx-preserve="true" value="${escape(filtre)}"
      placeholder="filtrer les lignes" aria-label="Filtrer le journal" spellcheck="false" autocapitalize="off"
      hx-get="${url}" hx-trigger="input changed delay:400ms, search" hx-target="#journal-${id}" hx-swap="outerHTML"
      hx-include="#journal-${id} .journal-reglages">
    <select name="lines" aria-label="Nombre de lignes" hx-get="${url}" hx-trigger="change"
      hx-target="#journal-${id}" hx-swap="outerHTML" hx-include="#journal-${id} .journal-reglages">${options}</select>
  </div>
  <pre>${escape(vide)}</pre>
${colle}</div>`;
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
    // La classe « job » n'habille rien : elle dit au sondage de la liste de ne
    // pas remplacer la carte tant que la tâche court (voir GARDES dans page.ts).
    return `<div class="job" hx-get="/api/jobs/${job.id}" hx-trigger="every 1500ms" hx-swap="outerHTML"><pre>${lignes}</pre></div>`;
  }
  const script = job.status === "réussi" ? `<script>setTimeout(() => location.reload(), 600)</script>` : "";
  return `<pre>${lignes}</pre>${script}`;
}
