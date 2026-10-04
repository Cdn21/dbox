# Dossier d'architecture

Ce document décrit **comment DBox est construit** : ses composants, leurs
responsabilités, les flux qui les traversent, et les décisions qui ont fixé
cette forme. Pour **ce que fait** DBox (modèle, manifeste, commandes), voir
[`REFERENCE.md`](REFERENCE.md) ; les diagrammes UML sont regroupés dans
[`UML.md`](UML.md) et référencés ici par leur numéro.

Les invariants que les tests protègent sont listés dans `CONTRIBUTING.md`, à la racine
du dépôt. Ce document les cite sans les redéfinir.

---

## 1. Objet et périmètre

DBox est une **couche d'exposition** pour du self-hosting. À partir d'un
manifeste (`dbox.toml`), il génère un projet Docker Compose standard, place
devant l'application un sidecar Tailscale qui lui donne un nom stable et du
HTTPS sur le tailnet, la démarre, vérifie qu'elle répond, et revient en arrière
sinon.

| Dans le périmètre | Hors périmètre, assumé |
| --- | --- |
| Générer Compose + config `tailscale serve` | Détecter la stack, écrire un `Dockerfile` |
| Construire, démarrer, vérifier, revenir en arrière | Migrations, sauvegarde des données |
| Inventaire des cibles, actions de cycle de vie | Métriques, comptes utilisateurs |
| Interface web privée (tailnet), CLI | Orchestration multi-serveur |
| Exposition publique optionnelle via un Traefik existant | Fournir ou configurer ce Traefik |

## 2. Contexte

Voir **diagramme 1** (contexte) dans [`UML.md`](UML.md).

| Acteur / système | Relation avec DBox |
| --- | --- |
| **Personne** (navigateur, téléphone, terminal) | Utilise le tableau de bord via le tailnet, ou la CLI sur la machine. |
| **Tailscale** (tailnet + plan de contrôle) | Donne à chaque cible un nœud, un nom DNS et un certificat. Fournit l'identité de l'utilisateur au daemon. |
| **API Tailscale** | Utilisée **uniquement** par le conteneur `authkey-rotator` : rotation de clé, nœuds abandonnés, lecture de `tagOwners`. |
| **Docker Engine** (hôte) | Construit et exécute les applications ; piloté par le socket. |
| **Forge git** (GitHub, GitLab, Forgejo…) | Source des applications (`dbox add`, `auto_deploy`), et du daemon lui-même (déploiement continu). |
| **Traefik** (optionnel, préexistant) | Expose une cible publique ; DBox ne pose que des labels sur ses propres conteneurs. |

## 3. Contraintes structurantes

Ces contraintes expliquent la plupart des choix de structure qui suivent.

- **Zéro dépendance à l'exécution.** Le parseur TOML (`toml.ts`) et l'émetteur
  YAML (`yaml.ts`) sont maison et volontairement partiels. Seuls `typescript` et
  `@types/node` existent, en outillage (`tsc --noEmit`).
- **Node 24 exécute le TypeScript en effaçant les types**, sans compilation :
  ni `enum`, ni propriétés de constructeur, ni décorateurs ; les imports portent
  l'extension `.ts`. Le code exécuté est exactement le code lu.
- **DBox est jetable.** Tout ce qu'il produit est un fichier standard et lisible
  (`docker-compose.yml`, `serve.json`, `dbox.json`, `state.json`). Le supprimer
  ne coupe rien.
- **Aucun port publié, jamais** (invariants 1 et 17). Toute entrée passe par un
  sidecar Tailscale, ou par un réseau Docker partagé avec Traefik.
- **Le daemon vaut root sur l'hôte** (il pilote le socket Docker). C'est le
  fait qui gouverne tout le modèle de sécurité (§ 8).

## 4. Vue logique

Voir **diagramme 2** (composants) et **diagramme 3** (classes du domaine).

Le code est organisé en quatre couches. La règle est simple : **plus une couche
est basse, moins elle touche au monde.** Les couches hautes injectent les effets
dans les couches basses, jamais l'inverse.

### 4.1 Noyau pur — aucun accès disque, réseau ou processus

| Module | Responsabilité |
| --- | --- |
| `toml.ts` | Sous-ensemble de TOML ; refuse tout le reste, avec la ligne (invariant 15). |
| `manifest.ts` | `dbox.toml` → `Manifest` validé. Union discriminée `Target` par `mode`. Les messages d'erreur sont le produit. |
| `compose.ts` | Une cible + un `Context` → objet Compose (sidecar, app, compagnons, labels Traefik). |
| `tsserve.ts` | Configuration `serve.json` du sidecar ; `${TS_CERT_DOMAIN}` reste littéral (invariant 2). |
| `yaml.ts` | Émission YAML, citation conservatrice (invariant 5). |
| `plan.ts` | `Manifest` + cible + `Context` → `Plan` : la liste exacte des fichiers à écrire, dont `dbox.json`. |
| `preflight.ts` | Ce qui va casser, dit **avant** de construire. N'empêche jamais rien. |
| `init.ts` | Déduit nom, port et volume d'un dossier et de son `Dockerfile`. |
| `env.ts` | Format `.env` : `CLÉ=valeur`, rien d'autre. |
| `ui/*` | Rendu HTML côté serveur. `ui/html.ts` porte l'échappement (invariant 8). |

Ce noyau est testé **sans Docker ni réseau** : c'est là que vit l'essentiel des
tests.

### 4.2 Orchestration — logique avec effets injectés

| Module | Responsabilité |
| --- | --- |
| `up.ts` | Le déploiement : refus de domaine → preflight → écriture → construction → démarrage → santé → état ou retour arrière. **Toutes ses dépendances externes passent par `UpDeps`.** |
| `actions.ts` | Les gestes de l'interface : start/stop/restart, journaux, `.env`, manifeste, redéploiement (pull + `up`), ajout (clone ou dossier local), suppression. |
| `registry.ts` | L'inventaire : balaie `<root>/*/*/dbox.json`, lit `state.json`, croise avec **un seul** `docker ps`. Ignore les descripteurs incohérents avec leur dossier. |
| `jobs.ts` | Tâches longues en mémoire (redéploiement, ajout), suivies en direct. La vérité durable reste `state.json`. |
| `poller.ts` | Sondage `auto_deploy` : `git fetch`, comparaison, redéploiement. Jamais de webhook. |
| `rotate.ts`, `orphans.ts`, `tagcheck.ts` | Tâches de l'`authkey-rotator`. Effets injectés comme `up.ts`. |

### 4.3 Adaptateurs — les seuls modules qui touchent au monde

| Module | Monde touché |
| --- | --- |
| `docker.ts` | Processus `docker compose` (sortie ligne à ligne). |
| `health.ts` | HTTP vers l'URL finale de la cible. |
| `writer.ts` | Disque : matérialise un plan, respecte `preserveIfExists` (invariant 3), sème la clé d'auth. |
| `state.ts` | `state.json`. |
| `tag.ts` | SHA git court, suffixe `-sale` si l'arbre est modifié. |
| `versions.ts` | Lien vers le commit déployé sur la forge, et commits de la source pas encore déployés — comparés au `HEAD` local, jamais de `fetch` (la liste se rend toutes les 15 s). Cache d'une minute. |
| `sources.ts` | `git clone` / `pull --ff-only` / `fetch` + comparaison. |
| `sshkey.ts` | Clé SSH dédiée aux clonages, par machine et par app ; jamais écrasée (invariant 14). |
| `lecture.ts` | Lecture prudente d'un fichier de projet (fichier ordinaire, taille bornée). |
| `tailscale.ts` | API Tailscale brute (clés, appareils, `tagOwners`). |
| `config.ts`, `machines.ts`, `authkey.ts`, `*-report.ts` | Fichiers de configuration et de rapport de la machine. |
| `vendor.ts` | htmx et Alpine, lus depuis `src/vendor/` et servis par le daemon. |

### 4.4 Points d'entrée

| Module | Rôle |
| --- | --- |
| `cli.ts` | `setup`, `init`, `plan`, `up`, `ls`, `add`, `rm`, `serve`, `rotate-authkey`. Assemble les dépendances réelles et les injecte. |
| `server.ts` | Daemon HTTP. `route()` est **pur** (méthode, chemin, en-têtes, `Deps` → `Response`) ; `createServer()` n'est qu'une glu mince autour. |
| `ui/index.ts` | Seule porte d'entrée de l'interface pour `server.ts`. |

### 4.5 Injection de dépendances

Il n'y a pas de conteneur d'injection : ce sont des **interfaces de fonctions**
passées en paramètre (`UpDeps`, `Deps`, `Actions`, `PollDeps`, `RotateDeps`…).
`cli.ts` les remplit avec les vraies implémentations ; les tests, avec des
doublures. C'est ce qui permet de tester un déploiement complet, retour arrière
compris, en quelques millisecondes et sans Docker.

## 5. Vue des processus

Voir **diagrammes 4 à 7** (séquences) et **8 à 10** (états).

### 5.1 Conteneurs du daemon (`deploy/docker-compose.yml`)

| Conteneur | Rôle | Accès |
| --- | --- | --- |
| `daemon` | `dbox serve` : tableau de bord, actions, sondage `auto_deploy`. | Socket Docker (via `group_add`), `DBOX_HOME`, `~/.ssh` en lecture, racine des espaces de travail. Tourne en UID 1000, pas en root. |
| `tailscale` | Sidecar du daemon, tag `tag:dbox-admin`. Termine TLS et injecte l'identité. | Réseau `internal` uniquement. |
| `authkey-rotator` | `dbox rotate-authkey --interval` : rotation, nœuds abandonnés, vérification du tag. | `DBOX_HOME` seulement. **Ni socket, ni clé SSH**, réseau `rotator` séparé, sans route depuis le sidecar. Seul à lire le token d'API. |

Le daemon et le rotator partagent la même image ; le rotator communique avec le
daemon **uniquement par fichiers de rapport** (`orphans-report.json`,
`tag-report.json`), jamais par le réseau.

### 5.2 Conteneurs d'une cible

| Mode | Conteneurs | Le sidecar joint |
| --- | --- | --- |
| `deployed` | `app` (image construite, taguée par SHA) + `tailscale` + compagnons | `app:<port>` |
| `devcontainer` | `app` (image de dev, sources bind-montées) + `tailscale` + compagnons | `app:<port>` |
| `workspace` | `tailscale` seul ; la commande tourne sur l'hôte | `host.docker.internal:<port>` |

Chaque cible est un projet Compose distinct (`dbox-<app>-<cible>`) avec son
propre réseau `internal`. Une cible publique rejoint en plus le réseau externe
de Traefik.

### 5.3 Concurrence

- Un seul redéploiement à la fois par cible (`Jobs.runningFor`) ; démarrer,
  arrêter ou redémarrer une cible en cours de redéploiement est refusé.
- Le sondeur ne fait jamais de `fetch` sur une cible déjà en redéploiement
  (invariant 13).
- La suppression d'une cible est refusée pendant un redéploiement (invariant 16).
- Le déploiement continu du daemon est sérialisé par `flock`.

## 6. Vue des données

Voir **diagramme 3** (classes) et **diagramme 11** (arborescence).

**Il n'y a pas de base de données : le système de fichiers est le registre.**
Une cible existe parce que son dossier existe.

```
<root>/<app>/<cible>/
  docker-compose.yml   généré à chaque plan
  serve.json           généré à chaque plan
  dbox.json            Descriptor : qui est cette cible (régénéré à chaque plan)
  state.json           State : version déployée, précédente, date (écrit sur succès seulement)
  .env                 secrets de l'app, 0600, jamais réécrit
  ts.env               clé d'auth du sidecar, 0600, jamais réécrit
  ts-state/            état du nœud Tailscale

$DBOX_HOME/
  authkey, authkey.expires, authkey.id    clé tag:dbox, son échéance, son identifiant
  admin-authkey.expires                   échéance de la clé tag:dbox-admin du daemon
  tailscale-api-token                     lu par authkey-rotator seulement
  ssh_key, ssh_key.pub, app-keys/<app>    clés de clonage (machine, puis par app)
  machines.json                           autres tableaux de bord connus
  orphans-report.json, tag-report.json    rapports du rotator, lus par le daemon

~/.config/dbox/config.toml                réglages de la machine (la CLI a le dernier mot)
```

| Donnée | Écrite par | Lue par | Durée de vie |
| --- | --- | --- | --- |
| `dbox.toml` | la personne (ou `init`/`up` s'il manque) | `up`, `actions` | celle du projet |
| `dbox.json` | `plan` via `writer` | `registry`, `poller`, `server` | régénéré |
| `state.json` | `up` (succès uniquement) | `up` (retour arrière), `registry` | durable |
| `.env`, `ts.env` | `writer` (amorce, une fois) | Docker | jamais réécrit |
| Jobs | `jobs.ts` | `server` | mémoire du daemon (20 derniers) |

## 7. Vue de déploiement

Voir **diagramme 12** (déploiement) et **diagramme 7** (déploiement continu).

Chaque machine fait tourner **son propre daemon**, indépendant : la
configuration de la machine (`target`) décide quelles cibles elle gère —
typiquement `prod` sur un serveur, `dev` sur un poste de travail. Les daemons ne
s'appellent jamais entre eux ; le sélecteur de machine de l'interface ne fait
que naviguer vers l'URL de l'autre.

**Amorçage** : DBox ne peut pas se déployer lui-même par son manifeste (il lui
faudrait un champ « montages » pour réclamer le socket Docker — invariant 7).
Il démarre donc par `deploy/docker-compose.yml`, écrit à la main.

**Mise à jour du daemon** (déploiement continu, en tirant) :

1. Un push sur une branche quelconque déclenche la CI (typecheck + tests).
2. Sur `main` seulement, la dernière étape avance la branche `production`
   en avance rapide.
3. Sur chaque machine, `deploy/maj-auto.sh` (cron, toutes les 5 minutes) tire
   `production` dans un clone dédié, refuse un commit absent de `main` ou qui
   ne descend pas de la version en place,
   construit, redémarre `daemon` et `authkey-rotator`, attend la santé,
   et revient à la version précédente en cas d'échec.

Aucune clé vers les machines n'entre dans la CI : ce sont les machines qui tirent.

## 8. Sécurité

### 8.1 Frontières de confiance

| Frontière | Garde |
| --- | --- |
| Internet → machine | Aucun port publié (invariants 1, 17). Seul Traefik, s'il est configuré, expose une cible publique. |
| Tailnet → daemon | Sans en-têtes d'identité Tailscale, réponse 401 (sauf `/health`). Les ACL du tailnet (`tag:dbox-admin`) décident qui y accède. |
| Page tierce → daemon | Toute écriture exige `x-dbox-action` : un formulaire tiers ne peut pas le poser, un `fetch` qui le pose déclenche un contrôle CORS auquel le daemon ne répond pas (invariant 9). |
| Disque → page | Tout ce qui vient du disque est échappé (invariant 8). Les valeurs destinées au JavaScript passent par des attributs `data-*`, jamais interpolées dans une expression. |
| Disque → registre | Un `dbox.json` dont `app`/`target` ne correspondent pas à son dossier, ou ne sont pas des labels DNS, est ignoré. |
| Registre d'images → hôte | Les images construites par DBox (`dbox/<app>:<tag>`) portent `pull_policy: never` : l'espace `dbox` de Docker Hub appartient à un tiers. Le retour arrière fait `up --no-build`. |
| Manifeste → hôte | Pas de champ « montages » ; un compagnon n'a que `image` et `data` (invariant 7). |
| Projet → daemon | Les fichiers sondés avant construction ne sont lus que s'ils sont ordinaires et de taille bornée. |
| Daemon → tailnet | Le token d'API Tailscale n'est jamais lisible depuis le daemon (conteneur `authkey-rotator` isolé). DBox ne réécrit jamais l'ACL. |
| CI → production | Le jeton de la CI est visible de toutes les étapes du job : la garde est côté machine. `main` est protégée ; les machines refusent un commit de `production` absent de `main`, ou qui ne descend pas de la version en place. |

### 8.2 Secrets

| Secret | Où | Règle |
| --- | --- | --- |
| Clé d'auth `tag:dbox` | `$DBOX_HOME/authkey` → `ts.env` de chaque cible | Semée après écriture, jamais affichée par `plan`. Tournée par le rotator. |
| Clé d'auth `tag:dbox-admin` | `deploy/ts.env` | Jamais réécrite ; seule son échéance est connue. |
| Token d'API Tailscale | `$DBOX_HOME/tailscale-api-token` | Posé à la main, lu par le rotator seulement. |
| Clés SSH de clonage | `$DBOX_HOME/ssh_key`, `app-keys/` | Générées une fois, jamais écrasées ; seule la clé publique est affichée. |
| `.env` des apps | dossier de la cible, 0600 | Valeurs masquées par défaut dans l'interface. |

## 9. Qualité et tests

- **`node:test`**, sans dépendance. Plus de 500 tests, moins d'une seconde.
- La **pureté** du noyau et l'**injection** dans l'orchestration permettent de
  tester les cas qui comptent — échec de construction, échec de santé, retour
  arrière, conflit de domaine — sans Docker ni réseau.
- Chaque invariant de `CONTRIBUTING.md` est gardé par au moins un test.
- **`tsc --noEmit`** vérifie les types sans générer de JavaScript.
- La CI rejoue typecheck et tests à chaque push, sur toutes les branches.

## 10. Décisions d'architecture

| # | Décision | Alternative écartée | Raison |
| --- | --- | --- | --- |
| D1 | Le système de fichiers est le registre | Base SQLite | Rien à synchroniser ; l'inventaire reste lisible avec `ls` et `cat` si DBox disparaît. |
| D2 | Générer du Compose standard | Format ou runtime maison | DBox est jetable ; les fichiers générés documentent ce qu'il a compris. |
| D3 | Un sidecar Tailscale par cible | Un port par app derrière un seul nœud | Nom stable par app, aucune collision, aucun port à retenir. |
| D4 | Santé vérifiée sur l'URL finale | Santé du conteneur | Ce qui compte est la chaîne entière : app, sidecar, nœud, certificat. |
| D5 | Retour à l'image précédente sur échec de santé | Laisser la nouvelle version | Un déploiement raté ne doit pas laisser le site mort. Partiel dès qu'il y a de l'état. |
| D6 | Sondage pour `auto_deploy` | Webhook | Un webhook exigerait un point d'entrée joignable depuis internet. |
| D7 | Rotation de clé dans un conteneur séparé | Bouton du daemon | Le daemon vaut root ; y mettre le token d'API étendrait une compromission à tout le tailnet. |
| D8 | ACL Tailscale en lecture seule | Écrire `tagOwners` automatiquement | L'API remplace la policy entière ; une erreur couperait l'accès à tout le tailnet. |
| D9 | Interface rendue côté serveur, htmx + Alpine vendorisés | SPA, CDN | Aucune ressource externe ; un CDN échapperait à tout contrôle. |
| D10 | Le preflight avertit, ne refuse jamais | Bloquer le déploiement | Ce sont des heuristiques ; refuser sur une supposition serait pire que le silence. |
| D11 | Déploiement continu en tirant | Pousser depuis la CI par SSH | Une clé SSH dans la CI vaudrait root sur les machines, pour toutes les branches. |
| D12 | Un daemon par machine, sans coordination | Un daemon central | Chaque machine reste autonome ; aucune ne dépend d'une autre pour fonctionner. |
| D13 | Les gardes du déploiement continu sont sur la machine | Les confier à la CI | Le runner expose le jeton à toutes les étapes ; seule la machine qui tire peut refuser un commit absent de `main` ou un retour en arrière. |

## 11. Limites connues et évolutions

- **Applications multi-conteneurs riches** : les compagnons n'ont que `image` et
  `data`. Pas de `depends_on` conditionnel, de commande ni de build — une app qui
  en a besoin écrit son propre Compose.
- **Mode `workspace`** : hors de portée du daemon d'une autre machine (le
  serveur de dev tourne sur le poste).
- **`ssh_port` et `public_domain`** ne se combinent pas encore.
- **Désenregistrer un nœud Tailscale** à la suppression d'une cible demanderait
  le token d'API dans le daemon, ce que D7 évite ; les nœuds abandonnés sont
  seulement signalés.
- **`dbox dev` / `dbox down`** : annoncés, pas encore écrits.
