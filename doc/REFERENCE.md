# DBox — référence

Self-host chez soi : tu poses ton code, DBox s'occupe du réseau.

Une app déployée devient joignable en `https://<nom>.<tailnet>.ts.net` — sans port ouvert,
sans DNS, sans certificat à gérer, sans reverse proxy à configurer.

---

## Installation

Découvres-tu DBox ? **[`GUIDE.md`](GUIDE.md)** part de l'intérêt et des cas
d'usage concrets ; **[`INSTALL.md`](INSTALL.md)** part de zéro — réseau
privé compris — et va plus lentement que ce qui suit ici.

Le seul vrai prérequis est **Docker**. `dbox` devient un lanceur qui exécute la
CLI dans le même conteneur que le daemon — Node 24, git, la CLI Docker, déjà
construits une fois. Plus jamais le problème rencontré deux fois pendant ce
projet : un `node` trop vieux qui traîne dans le `PATH`.

```
git clone <url-du-dépôt> dbox
cd dbox
./install.sh                              # vérifie Docker, construit l'image,
                                           # pose `dbox` dans ~/.local/bin
dbox setup                                # configure cette machine, une fois
```

`dbox setup` pose les quatre réglages qui ne changent jamais d'une commande à
l'autre (tailnet, cible, racine, tag) et écrit `~/.config/dbox/config.toml` —
jamais la clé Tailscale elle-même : `setup` affiche la commande à taper à la
main pour la poser, un secret ne doit transiter par aucun outil qui pourrait
le journaliser.

Ce qu'`install.sh` ne fait jamais : modifier un fichier de démarrage de shell,
ou déployer le daemon lui-même. `deploy/docker-compose.yml` reste un geste
délibéré — c'est lui qui obtient l'accès au socket Docker (voir plus bas).

### Déploiement continu du daemon

Le daemon DBox se met à jour **en tirant**, jamais en recevant :

```
push sur main ──► CI Forgejo : typecheck + tests ──► vert ? la branche `production` avance
                                                           │
                         chaque machine, par cron ◄────────┘  (git fetch toutes les 5 min)
                         └─► deploy/maj-auto.sh : construit, redémarre, vérifie la santé
```

- **La CI** (`.forgejo/workflows/ci.yml`) teste chaque push, sur toutes les
  branches. Sur `main` seulement, une fois les tests verts, elle avance la
  branche `production` — qui ne pointe donc jamais que sur un commit testé.
- **Chaque machine** suit `production` avec `deploy/maj-auto.sh`, lancé par
  cron depuis un **clone dédié** (`~/dbox/tool`), jamais depuis un dossier de
  travail : le script y fait des `git reset --hard`. Il ne redémarre que le
  daemon et le rotator, attend la santé, et **revient à la version précédente**
  si la nouvelle ne démarre pas.
- **Aucune clé vers les machines n'entre dans la CI.** Le runner exécute ses
  jobs dans un Docker-in-Docker isolé, précisément pour qu'un workflow ne puisse
  pas atteindre la production ; lui donner un accès SSH, qui vaut root dès qu'on
  pilote Docker, annulerait cette isolation pour toutes les branches.
- **`production` ne déploie que ce que `main` contient.** Le jeton de la CI peut
  pousser `production`, et la CI tourne sur toutes les branches : une branche
  qui réécrirait le workflow pourrait donc y pousser n'importe quoi — et le
  runner expose ce jeton à toutes les étapes, `npm ci` et tests compris. Les
  verrous sont donc côté machine : `main` est une branche protégée que seule
  une personne peut pousser (pas le jeton de la CI), et `maj-auto.sh` refuse
  tout commit de `production` absent de `main`, ou qui ne descend pas de la
  version en place (un retour en arrière se fait sciemment, `DBOX_MAJ_FORCER=1`).

Mise en place sur une machine (une fois) :

```bash
git clone ssh://git@<forge>/<propriétaire>/DBox.git ~/dbox/tool
cd ~/dbox/tool && git checkout production
cp <ancien>/deploy/.env <ancien>/deploy/ts.env deploy/   # jamais versionnés
crontab -e   # puis :
# */5 * * * * ~/dbox/tool/deploy/maj-auto.sh >> ~/dbox/maj-auto.log 2>&1
```

Le clone n'a besoin que d'un accès **en lecture** : une clé de déploiement en
lecture seule, propre à la machine (`git config core.sshCommand` dans le clone),
plutôt qu'une clé personnelle — qui demanderait de plus un agent SSH, absent
sous cron.

## Le problème

Aujourd'hui, mettre une app en ligne chez soi demande, à chaque fois, la même série de gestes
manuels : écrire un `docker-compose.yml`, deviner les labels du reverse proxy, choisir un port
libre, créer un enregistrement DNS, obtenir un certificat, écrire une unit systemd pour que ça
revienne après un reboot.

Aucun de ces gestes n'est intéressant, et aucun n'a de rapport avec le fait de coder.

## Principe directeur : DBox est jetable

DBox **génère des `docker-compose.yml` standards et lisibles**, puis appelle `docker compose`
et la CLI `tailscale`. Il n'invente aucun format, n'embarque aucun runtime maison, ne prend
possession de rien.

Conséquences voulues :

- les apps déjà en place sur la machine ne bougent pas — zéro risque de casse ;
- tu supprimes DBox demain : tout continue de tourner, et tu reprends les fichiers à la main ;
- chaque fichier généré est lisible, donc c'est aussi une documentation de ce que DBox a compris.

C'est ce qui protège du lock-in sur sa propre machine.

---

## Le modèle : une couche d'exposition, trois formes de cible

DBox ne s'occupe que de **l'exposition**. Ce qu'il expose s'appelle une **cible**.

```
   toi, ton téléphone,     ┌────────────────────────────────────┐
   n'importe où      ────► │   budget.mon-tailnet.ts.net         │
   sur le tailnet          │   nom stable · HTTPS · ACL · vie   │  ← DBox, toujours identique
                           └─────────────────┬──────────────────┘
                                             │
                           ┌─────────────────▼──────────────────┐
                           │            la cible                │  ← 3 formes, au choix
                           └────────────────────────────────────┘
```

Quelle que soit la forme, DBox garantit exactement trois choses : **un nom**, **du HTTPS**,
**un cycle de vie** (démarrer, arrêter, redémarrer au boot). Ce qui change d'une forme à
l'autre, c'est seulement ce qu'il y a derrière le proxy.

| `mode`          | ce qui tourne                                        | tourne sur        | tu édites          | boucle                    |
| --------------- | ---------------------------------------------------- | ----------------- | ------------------ | ------------------------- |
| `workspace`     | ta commande, en direct sur ta machine                | poste de travail  | ton dossier        | HMR, instantané           |
| `devcontainer`  | ta commande, dans un conteneur, sources bind-montées | poste ou serveur  | ton dossier        | HMR, instantané           |
| `deployed`      | une image construite depuis ton `Dockerfile`         | serveur           | rien, c'est figé   | rebuild au déploiement    |

Entre `workspace` et `devcontainer`, **la boucle de code est identique** : tu sauves, ça se
recharge. La seule différence est l'isolation — `devcontainer` donne la parité avec la
production, au prix des contraintes listées plus bas.

`deployed` est d'une autre nature : c'est figé, et ça survit à l'extinction du poste.

### L'image de développement

Une image toute faite suffit rarement : dès qu'un projet mêle deux runtimes —
un serveur Python et Vite, par exemple — il lui faut la sienne. Le mode
`devcontainer` accepte donc un `dockerfile`, construit sans rien copier, puisque
les sources sont montées depuis le dépôt.

```toml
[targets.dev]
mode = "devcontainer"
dockerfile = "Dockerfile.dev"
command = "./run.sh dev"
port = 5173
```

### Un nœud tailnet par app, pas un port par app

Chaque cible obtient un sidecar `tailscale/tailscale` (mode userspace) et **son propre nom
de machine** sur le tailnet. Pas de `:8443` à retenir, pas de numéro de port à réserver,
pas de collision possible quand on en ajoute une de plus.

L'app n'écoute que dans son réseau Docker : **aucun port publié sur l'hôte**.

---

## Le manifeste

Un seul fichier à écrire, `dbox.toml`, à la racine du projet :

```toml
name = "budget"

[targets.dev]
mode = "workspace"        # ← bascule en "devcontainer" quand tu veux : une ligne
command = "npm run dev"
port = 5178
                          # → https://budget-dev.mon-tailnet.ts.net

[targets.prod]
mode = "deployed"
port = 8080
health = "/healthz"       # interrogé après déploiement (défaut « / »)
                          # → https://budget.mon-tailnet.ts.net
```

Une app peut avoir plusieurs cibles en même temps, chacune avec **son URL distincte**.
Les deux noms sont différents exprès : confondre la version en cours d'édition et celle qui
tourne pour de vrai coûte toujours une heure.

Les secrets ne sont **pas** dans le manifeste : ils vivent dans un `.env` en `0600` à côté
des fichiers générés, injecté au lancement.

### ACL par cible

Par défaut, une cible porte le tag de la machine (`tag:dbox`) — tout le monde qui y a
accès voit toutes les apps. Une cible peut s'en isoler avec son propre tag :

```toml
[targets.prod]
mode = "deployed"
port = 8080
ts_tag = "tag:budget-only"
```

DBox ne fait que poser le tag sur le nœud — il ne touche jamais à la policy du tailnet.

### Backend d'exposition : Tailscale ou Headscale

Par défaut une cible est exposée via **Tailscale**. Une machine peut choisir
**Headscale** (coordination auto-hébergée) comme défaut (`backend` dans
`config.toml`, `--backend`, `DBOX_BACKEND`), et une cible peut le redéfinir
comme `ts_tag` :

```toml
[targets.prod]
mode = "deployed"
port = 8080
backend = "headscale"   # sinon le défaut de la machine
```

En backend Headscale, `tailscale serve` ne pouvant pas obtenir de certificat
(pas de `tailscale cert`), DBox génère un sidecar à **deux conteneurs** —
`tailscaled` non-userspace + un Caddy voisin qui termine le TLS avec un
certificat wildcard que tu fournis. La machine pose alors
`headscale_login_server`, `headscale_cert_dir` (dossier du `<tailnet>.crt`/
`.key`) et `headscale_authkey_file` (clé préauth distincte de la clé Tailscale).
Le rotateur régénère cette clé via l'API Headscale si `headscale_api_token_file`
et `headscale_user` (son **id numérique**) sont posés. `ssh_port` n'est pas pris
en charge avec ce backend.

En Headscale la clé préauth appartient à un **user** (pas à un tag) : ce user doit
exister dans Headscale, et c'est la policy ACL de **ton** Headscale qui restreint
qui joint les nœuds — pas la console Tailscale. En backend **Tailscale**, le
prérequis équivalent est que `tag:dbox` existe déjà dans `tagOwners`, sinon le
sidecar échoue à s'enregistrer ; restreindre `src` dans les `grants` de ce tag
(à autre chose que `autogroup:member`) reste à faire à la main dans la console
admin Tailscale. Les deux cas sont des prérequis manuels du premier démarrage.

### Services compagnons

Une app a souvent besoin d'une base à côté d'elle. Elle se déclare dans la cible :

```toml
[targets.prod]
mode = "deployed"
port = 8080

[targets.prod.services.db]
image = "postgres:16-alpine"
data = "/var/lib/postgresql/data"
command = "postgres -c max_connections=200"   # optionnel : la commande du conteneur
healthcheck = "pg_isready -U app"             # optionnel : l'app attend qu'il soit SAIN
```

L'app la joint par son nom sur le réseau interne : `db:5432`. Rien n'est publié, et
un compagnon n'est **jamais** exposé — ni port, ni label de reverse proxy, même quand
la cible est publique. Seule l'app l'est.

Volontairement pauvre : `image`, `data`, et au plus `command` et `healthcheck` —
**pas de build, aucun montage de l'hôte**, c'est cette impossibilité qui garantit
qu'une app ne peut pas réclamer le socket Docker. `command` et `healthcheck`
s'exécutent dans le conteneur du compagnon, jamais sur l'hôte. Pour un conteneur à
construire, écris ton propre `docker-compose.yml` : DBox est jetable, c'est prévu.

Un `healthcheck` posé change la dépendance : sans lui, l'app démarre dès que le
compagnon est **lancé** (`service_started`), à elle de réessayer sa connexion ;
avec lui, l'app attend qu'il soit **sain** (`service_healthy`) — c'est ce qu'il faut
pour une base qui met une seconde à accepter les connexions, et ce qui permet à une
app comme `appvc_api` de se poser sur DBox sans Compose écrit à la main.

Trois choses à savoir :

- **Les variables vont dans le `.env` de la cible**, partagé avec l'app. Une image
  comme `postgres` refuse de démarrer sans les siennes (`POSTGRES_PASSWORD`) — DBox
  prévient quand le fichier vient d'être créé vide, parce que le contrôle de santé
  porte sur l'app et ne verrait jamais une base qui redémarre en boucle.
- **Chaque compagnon a son volume nommé** (`db-data` ici), qui survit à `dbox rm`
  comme celui de l'app.
- **Le retour arrière ramène l'image, jamais les données.** Une migration déjà
  appliquée ne se défait pas : la garantie « un échec de santé revient à la version
  précédente » devient partielle dès qu'il y a de l'état.

Absent du mode `workspace` : sans conteneur d'app, un compagnon serait injoignable
depuis le processus qui tourne sur l'hôte.

### Cible publique

Par défaut, une cible n'est joignable que par le tailnet. Elle peut **en plus** être
exposée sur internet, via le Traefik déjà en service sur la machine :

```toml
[targets.prod]
mode = "deployed"
port = 8080
public_domain = "budget.exemple.fr"
```

L'app répond alors aux deux adresses : `https://budget.mon-tailnet.ts.net` (privée) et
`https://budget.exemple.fr` (publique). **Le sidecar continue de tourner** — l'exposition
s'ajoute, elle ne remplace rien : l'accès privé reste disponible même si la route
publique casse.

L'invariant tient toujours : **aucun port n'est publié**, même pour une cible publique.
Traefik joint le conteneur par un réseau Docker partagé, exactement comme le sidecar le
fait par le réseau interne. DBox pose seulement, sur son propre conteneur, les labels que
le provider Docker de Traefik découvre tout seul — il ne modifie jamais la configuration
de ce Traefik.

Ce Traefik n'est **pas fourni par DBox** : il doit déjà tourner sur la machine, avec son
réseau et son resolver ACME (prérequis manuel, comme le tailnet ou `tagOwners`). Deux
réglages machine, à poser ensemble ou pas du tout :

```toml
traefik_network       = "traefik-net"   # le réseau Docker externe qu'il écoute
traefik_cert_resolver = "letsencrypt"   # son resolver ACME
```

Une cible qui pose `public_domain` sans ces réglages est refusée, avant toute écriture.
`public_domain` n'existe pas en mode `workspace` (sans conteneur, rien à router), et
n'est jamais hérité d'un défaut de machine : chaque cible publique le déclare
elle-même. `ssh_port` et `public_domain` ne se combinent pas encore. Enfin, deux cibles
qui revendiqueraient le même domaine sont refusées au déploiement — sinon Traefik en
router une au hasard, en silence.

## Les commandes

```
dbox add <url>     # clone un dépôt, écrit son manifeste au besoin, et déploie
dbox init          # écrit dbox.toml d'après le dossier et son Dockerfile
dbox plan          # affiche les fichiers générés, sans rien toucher
dbox up            # build + déploie       → https://budget.mon-tailnet.ts.net
dbox rm <app>      # arrête et supprime une cible — source et volumes intacts
dbox doctor        # vérifie les prérequis de la machine, sans rien modifier
dbox ls            # ce qui tourne, où, depuis quand, avec quelle URL
dbox serve         # le daemon : la même chose dans un navigateur
dbox rotate-authkey # régénère authkey_file via l'API si l'échéance approche
dbox dev <app>     # (re)démarre la cible dev     → https://budget-dev.…
dbox down <app>    # coupe une cible (sans supprimer) ; --target si plusieurs
```

Ajouter une app tient en une commande, sans option et sans clé à manipuler.
Sans `dbox.toml`, `up` en écrit un lui-même avant de continuer — exactement
ce que fait `dbox init` séparément, mais il n'y a pas de raison de taper les
deux quand une suffit :

```
$ dbox up ~/dbox/mon-app
aucun dbox.toml : j'en écris un
écrit /home/serve/dbox/mon-app/dbox.toml
  nom    mon-app
  port   80   (depuis EXPOSE)
  data   /data   (depuis VOLUME)

mon-app · prod · t20260810092819
  clé posée /home/serve/dbox/apps/mon-app/prod/ts.env
  construction… démarrage…
  en ligne · https://mon-app.mon-tailnet.ts.net
```

`dbox init` reste utile seul quand tu veux relire ou ajuster le manifeste
avant de déployer — `up` ne le régénère jamais s'il existe déjà, même
invalide : un manifeste mal formé se corrige, il ne se remplace pas en
silence par une proposition devinée.

#### Ajouter une app depuis un dépôt

`dbox add git@github.com:moi/mon-app.git` clone, déduit un manifeste s'il n'y
en a pas, et déploie — le même principe que `dbox up` sur un dossier local,
mais sans avoir à poser les sources sur la machine au préalable. Le
formulaire de la page fait exactement ça, en tâche de fond suivie en direct.

`dbox up --pull` tire le dépôt avant de redéployer, et un redéploiement lancé
depuis l'interface tire toujours : c'est ce que veut dire « redéployer » pour
une app dont la source est un dépôt. `--ff-only` : une divergence n'est jamais
résolue automatiquement, elle est signalée.

#### Ajouter un dossier déjà présent sur la machine

Le formulaire de la page propose aussi « Dossier local », à côté de « Dépôt
git », quand la machine a une racine configurée (`--workspaces-root`,
`DBOX_WORKSPACES`) — pour un projet déjà en cours d'édition, sans avoir à le
cloner une seconde fois. Le champ liste les sous-dossiers de cette racine à
choisir, plutôt que de taper un nom à l'aveugle ; le chemin retenu reste
**relatif** à la racine, et DBox refuse un `..` ou un chemin absolu plutôt
que de laisser échapper à ce que le conteneur du daemon a monté.

Cette racine est propre à chaque machine, sans défaut déduit : le conteneur
du daemon ne voit que ce qui est explicitement monté (`DBOX_HOME`, et cette
nouvelle racine si elle est posée) — un dossier ailleurs sur le disque lui
reste invisible, même avec un bouton dans l'interface.

#### Supprimer une app

`dbox rm <app>` (`--target` si l'app a plusieurs cibles) arrête la cible par
`docker compose down` puis supprime son dossier généré — c'est tout ce
qu'il faut pour qu'elle disparaisse du registre, puisque le système de
fichiers **est** le registre. Une confirmation est demandée (`--yes` pour un
script) ; le bouton « Supprimer » de la page pose la même question via le
navigateur.

**Ni le dossier source ni les volumes de données nommés ne sont touchés** —
`down` sans `--volumes`. Le dossier source peut encore servir à une autre
cible de la même app (`dev` et `prod` partagent souvent le même dépôt cloné),
et une donnée perdue ne se récupère pas alors qu'un dossier ou un volume
oublié, si. Rien n'est supprimé si `down` échoue, ni si un redéploiement de
cette cible est en cours.

### Redéploiement automatique — optionnel, et jamais par webhook

```toml
[targets.prod]
mode = "deployed"
port = 8080
auto_deploy = true   # absent en mode workspace : rien à y reconstruire
```

Le daemon sonde les cibles marquées ainsi — `git fetch` puis comparaison avec
la branche amont, à intervalle réglable (`--poll-interval`, 300 s par défaut ;
`0` désactive tout sondage). Rien n'est redéployé si rien n'a changé.

**Volontairement pas de webhook.** Un webhook demanderait un point d'entrée
joignable depuis internet — la première brèche dans l'invariant central de
DBox, « aucun port ouvert, invisible d'internet ». Le sondage reste entièrement
privé, au prix d'un délai de quelques minutes plutôt que l'instantané.

`auto_deploy` est **par cible**, jamais par défaut : une app n'a cette option
que si son `dbox.toml` le dit explicitement.

## La configuration : deux niveaux

**Celle d'une app** — ses variables d'environnement — s'édite depuis l'interface,
valeurs masquées par défaut. Enregistrer recrée le conteneur pour qu'il relise le
fichier, sans reconstruire l'image. Une cible **à l'arrêt n'est pas démarrée** :
enregistrer un réglage ne doit pas remettre en marche ce qu'on avait coupé.

Le format reste pauvre — `CLÉ=valeur`, rien d'autre — parce que tout ce qu'on y
ajouterait creuserait un écart entre ce que l'interface montre et ce que le
conteneur reçoit. Les commentaires ne survivent donc pas à une édition.

### La configuration de la machine

Ce qui ne change jamais d'une commande à l'autre n'a rien à faire sur la ligne
de commande. Une fois, dans `~/.config/dbox/config.toml` :

```toml
root         = "/home/serve/dbox/apps"
tailnet      = "mon-tailnet.ts.net"
ts_tag       = "tag:dbox"
authkey_file = "/home/serve/dbox/authkey"
target       = "prod"
# traefik_network / traefik_cert_resolver : voir « Cible publique »
```

`target` est ce qui fait qu'un même dépôt se déploie différemment selon la
machine : **DBox sur le serveur travaille sur `prod`, DBox sur le poste sur
`dev`**, sans changer une ligne du manifeste. Chaque instance gère ses propres
cibles — aucune ne dépend d'une autre pour fonctionner. Un sélecteur dans
l'en-tête de la page permet de sauter d'un tableau de bord à l'autre : chaque
machine tient sa propre liste des autres (nom + URL), éditable depuis
`/settings`, indépendamment des autres — pas de source de vérité partagée,
pas de synchronisation. Le navigateur, lui, connaît les deux : changer de
machine dans le sélecteur navigue simplement vers son URL.

`authkey_file` est la clé d'authentification Tailscale, posée **une seule fois**.
DBox en amorce le `ts.env` de chaque nouvelle cible. Elle n'est jamais affichée
par `dbox plan` — le semis a lieu après l'écriture, précisément pour qu'une clé
ne se retrouve pas dans une sortie de terminal. Et un `ts.env` existant n'est
jamais touché : la règle qui protège les clés déjà posées prime sur le semis.

Les options de la ligne de commande gardent le dernier mot.

### La clé SSH dédiée aux clonages

`dbox add` a besoin d'authentifier des clonages git. Par défaut il emprunte
`~/.ssh` de l'hôte — la clé **personnelle** de qui installe DBox, valable
pour tous ses dépôts. Une clé dédiée, à côté de la clé Tailscale, réduit ça
au strict nécessaire : autorisable dépôt par dépôt (*deploy key* GitHub,
*deploy token* GitLab), révocable sans toucher à l'identité de la personne.

Elle se génère et se consulte **depuis le tableau de bord** — pas de terminal
requis : un panneau « Accès git » propose *Générer* tant qu'aucune clé
n'existe, puis affiche la clé publique (jamais la privée) à coller dans les
réglages du dépôt. Même règle que la clé Tailscale : générée une fois, jamais
regénérée en écrasant celle déjà collée ailleurs.

```toml
ssh_key_file = "/home/serve/dbox/ssh_key"   # défaut : à côté d'authkey_file
```

Ce champ est optionnel — absent, `dbox add`/`dbox up --pull`/le sondage
`auto_deploy` retombent sur `~/.ssh` comme avant.

```
APP · CIBLE    ÉTAT       VERSION            DEPUIS  URL
budget · prod  en marche  1491cb9f572c-sale  9 min   https://budget.mon-tailnet.ts.net
temoin · prod  en marche  t20260809203611    20 min  https://temoin.mon-tailnet.ts.net
```

### Rotation automatique de la clé Tailscale (`tag:dbox`)

La clé d'auth réutilisable semée dans chaque nouvelle app expire — 90 jours
maximum, imposé par Tailscale. `dbox rotate-authkey`
la régénère elle-même via l'API Tailscale avant l'échéance, sans passer par
la console à la main — et révoque l'ancienne clé une fois la nouvelle en
place (jamais l'inverse ; un échec de révocation n'est qu'un oubli de
ménage, pas un échec de la rotation).

Volontairement une tâche **séparée du daemon**, pas un bouton du tableau de
bord : elle seule connaît un token d'accès API Tailscale, un secret aux mêmes
droits que le compte qui l'a créé (pas de scope plus fin disponible sans
client OAuth, indisponible sur ce plan). Le daemon, lui,
vaut déjà root sur la machine hôte via le socket Docker ; ajouter ce token
dans le même processus ferait qu'une compromission du daemon devienne une
compromission de tout le tailnet, pas seulement de cette machine.

`deploy/docker-compose.yml` la fait tourner dans un **troisième conteneur**,
`authkey-rotator` : ni le socket Docker, ni les montages `$DBOX_SSH`/
`$DBOX_WORKSPACES`, son propre réseau Compose sans route depuis le sidecar
Tailscale — injoignable depuis le tailnet, rien à cloner ni déployer.

```toml
api_token_file = "/home/serve/dbox/tailscale-api-token"   # défaut : à côté d'authkey_file
```

Le token se génère dans Settings → Keys → **API access tokens** de la console
Tailscale (pas Settings → Keys → Auth keys, ni un client OAuth), puis se pose
à la main, une fois : `echo 'tskey-api-...' > ~/dbox/tailscale-api-token`.
Jamais écrit par DBox lui-même — même règle que la clé Tailscale elle-même.

Portée délibérément restreinte à cette seule clé : ni celle du daemon
lui-même (`tag:dbox-admin`, dans `ts.env`, protégée par la même règle que
`.env` — jamais réécrite si elle existe), ni le désenregistrement d'un nœud
Tailscale à la suppression d'une cible (`dbox rm`) — ce dernier demanderait
que le token soit lisible depuis le daemon, ce que cette architecture évite
justement.

Le même conteneur signale aussi les nœuds `tag:dbox` sans connexion depuis
plus de 14 jours — dans ses journaux, et sur `/settings` (un fichier de
rapport partagé, jamais un appel API depuis le daemon). Jamais une
suppression automatique, un rapport à lire. Sur l'ancienneté de la dernière
connexion (`lastSeen`), jamais une comparaison au registre local : DBox
tourne sur plusieurs machines qui ne gèrent chacune que leurs propres cibles
(`serve` fait `prod`, pc-cde fait `dev`) et ne s'appellent jamais entre
elles — comparer au registre d'une seule aurait signalé à tort les cibles
bien vivantes des autres.

Il vérifie aussi, en lecture seule, que `--ts-tag` est bien déclaré dans
`tagOwners` de la policy Tailscale — sans ça, `dbox add` échoue à
l'inscription du nouveau nœud sans que la cause saute aux yeux. **DBox ne
réécrit jamais l'ACL lui-même** : contrairement à une clé ou un appareil, la
policy gouverne tout le tailnet d'un coup, et l'API la remplace en entier,
pas de correctif ciblé possible — un bug dans un cycle automatisé
lire-modifier-écrire casserait potentiellement l'accès à toute la machine,
pas qu'à une app. Quand le tag manque, `/settings` affiche la ligne exacte à
coller dans `tagOwners`, calquée sur un tag déjà présent dans la policy —
DBox suggère, ne modifie jamais.

### Le daemon : piloter depuis le téléphone

`dbox serve` sert la même liste dans un navigateur. Déployé avec son propre
sidecar, il devient `https://dbox.<tailnet>.ts.net` — joignable depuis un
téléphone en 4G comme depuis le poste, sans port ouvert, invisible d'internet.

**Un daemon par machine**, pas un seul pour tout piloter : `serve` fait tourner
`dbox`, pc-cde fait tourner `dbox-dev` (`DBOX_HOSTNAME` dans `deploy/.env` —
deux nœuds tailnet ne peuvent pas porter le même nom). Chaque instance montre
les cibles de sa propre machine, cohérent avec `target` qui fixe déjà ce que
chaque machine gère. Pas d'app native, pas d'Electron : le client est un
navigateur, déjà disponible partout, déjà capable d'ouvrir n'importe laquelle
des deux URL.

Depuis la page : **redéployer, arrêter, démarrer, éditer la configuration, lire
les journaux**. Un redéploiement dure des minutes, donc il devient une tâche
suivie en direct ; deux redéploiements simultanés sur la même cible sont
refusés. Recharger la page n'en perd pas le suivi, et les actions de la carte
restent grisées tant qu'elle tourne. Arrêter ou redémarrer une cible `deployed`
demande confirmation ; une cible de dev, non. Les journaux se filtrent (sur le
serveur, pour survivre au suivi en direct), et le formulaire d'ajout montre le
`dbox.toml` qu'il écrira avant qu'on clique.

Trois gardes encadrent l'accès :

- **La liste d'autorisation** (`--allowed-users`, `DBOX_ALLOWED_USERS`), quand
  elle est posée : seules les identités Tailscale listées passent, les autres
  reçoivent 403, lectures comprises. Sans elle (défaut), toute identité du
  tailnet passe et l'ACL du tailnet est la seule frontière — à poser pour
  qu'un appareil invité ou compromis du tailnet ne lise pas l'`env` d'une app
  ni ne pilote quoi que ce soit.

- **L'identité.** Elle vient des en-têtes que `tailscale serve` ajoute aux
  requêtes proxifiées. Sans elle, rien n'est servi — le seul chemin d'accès est
  donc le sidecar, et par lui l'ACL du tailnet. Seul `/health` échappe à la
  règle : c'est le conteneur qui s'interroge lui-même, en local.
- **Un en-tête maison** (`x-dbox-action`) est exigé sur toute écriture. Un
  formulaire d'un site tiers ne peut pas en poser, et un `fetch` qui en pose
  déclenche un contrôle préalable auquel on ne répond jamais. Sans lui,
  l'identité étant injectée par le proxy, n'importe quelle page ouverte dans le
  navigateur pourrait déclencher un déploiement.

La page est rendue côté serveur, sans ressource externe : ce que le navigateur
charge — la page, htmx, Alpine — vient toujours du daemon lui-même, jamais d'un
CDN. L'interactivité passe par htmx (attributs `hx-*`, le serveur répond en
fragments HTML) et Alpine (l'état purement local : un champ qui s'affiche ou
pas, une ligne qu'on ajoute avant l'enregistrement). Les deux sont vendorisés
(`src/vendor/`, servis en `/htmx.js` et `/alpine.js`) plutôt que chargés depuis
`unpkg` : un `<script src="...">` vers un CDN romprait l'invariant, un
CDN qui change son contenu échapperait à tout contrôle.

**DBox se déploie par un compose écrit à la main** (`deploy/`), et c'est délibéré.
Le daemon a besoin du socket Docker ; ajouter un champ « montages » au manifeste
donnerait à *n'importe quelle app* le moyen de réclamer ce socket, c'est-à-dire
root sur la machine. Ce champ n'existera pas. DBox s'amorce comme un compilateur
qui a besoin d'un premier binaire qu'il n'a pas produit.

Corollaire : le daemon porte le tag **`tag:dbox-admin`**, distinct du `tag:dbox`
des apps. Restreindre l'accès à l'administration ne doit pas restreindre l'accès
à budget, et réciproquement.

### Le registre : le système de fichiers

Il n'y a pas de base de données. **Une cible existe parce que son dossier
existe.** Chaque dossier généré est auto-descriptif :

- `dbox.json` — qui elle est : app, cible, mode, nom de machine, URL, projet
  Compose, et le chemin des sources. Régénéré à chaque plan.
- `state.json` — ce qui tourne : version déployée, version précédente, date.
  Écrit uniquement sur un déploiement réussi.

`dbox ls` balaie `apps/*/*/`, lit ces deux fichiers, et croise avec un seul
appel à `docker ps`. Rien à synchroniser, rien qui puisse mentir sur ce qui est
réellement déployé — et si DBox disparaît, l'inventaire reste lisible avec `ls`
et `cat`.

### Ce que fait `dbox up`

1. **Écrit** les fichiers du plan. `ts.env` et `.env` ne sont écrits qu'une fois :
   ce sont des amorces que tu remplis, les réécrire effacerait la clé d'auth et
   tes secrets.
2. **Construit** l'image et la tague avec le SHA git des sources
   (`-sale` si l'arbre est modifié, pour ne pas confondre deux versions).
3. **Démarre** la pile.
4. **Vérifie** — en interrogeant **l'URL finale**, pas le conteneur. Ce qui compte
   n'est pas qu'un processus tourne, mais que la chaîne entière réponde : app,
   sidecar, nœud tailnet, certificat. Le premier démarrage laisse le temps au
   certificat d'être délivré (180 s par défaut).
5. **Revient en arrière** si la vérification échoue.

Deux garanties qui décident du comportement en cas de pépin :

- un échec de **construction** ne touche à rien — la version en place continue de
  tourner, `up` n'a même pas été appelé ;
- un échec de **santé** remet l'image précédente, quand il y en a une. Au tout
  premier déploiement il n'y a rien où revenir : DBox le dit plutôt que de faire
  semblant. Et une cible de développement n'est jamais coupée — arrêter un
  environnement qui tournait serait pire que le déploiement raté.

La version déployée est notée dans un `state.json` lisible, à côté des fichiers
générés. C'est la seule chose que DBox sait et que Docker ignore : quelle version
remettre en place.

**Le contrôle de santé implique que la machine qui exécute DBox soit sur le
tailnet** — c'est le cas de `serve`.

## Ce que ça génère

```yaml
# /opt/dbox/apps/budget/prod/docker-compose.yml — généré par DBox, ne pas éditer
name: dbox-budget-prod

services:
  app:
    image: dbox/budget:a3f91c2        # tag = SHA git → rollback = re-up du tag précédent
    pull_policy: never                # construite ici, jamais tirée d'un registre
    restart: unless-stopped
    env_file: [./.env]
    user: "1000:1000"
    networks: [internal]              # aucun port publié sur l'hôte

  tailscale:
    image: tailscale/tailscale:stable
    hostname: budget                  # → budget.mon-tailnet.ts.net
    environment:
      TS_AUTHKEY: ${DBOX_TS_AUTHKEY}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "true"            # ni NET_ADMIN, ni /dev/net/tun
      TS_SERVE_CONFIG: /config/serve.json
      TS_EXTRA_ARGS: --advertise-tags=tag:dbox
    volumes:
      - ./ts-state:/var/lib/tailscale
      - ./serve.json:/config/serve.json:ro
    restart: unless-stopped
    networks: [internal]

networks:
  internal:
    name: dbox-budget-prod_internal
```

```json
// serve.json — le sidecar termine le TLS et proxifie vers l'app
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": { "/": { "Proxy": "http://app:8080" } }
    }
  }
}
```

---

## Périmètre

### Ce que DBox fait

Exposer une cible sur le tailnet — nom, HTTPS, cycle de vie — dans les trois modes ;
l'exposer **en plus** sur internet via un Traefik déjà en place (`public_domain`) ; la
déployer depuis un dossier local ou un dépôt git (`dbox add`, `auto_deploy`) ; et la
piloter depuis un tableau de bord privé, avec une ACL par cible (`ts_tag`) — DBox pose le
tag sur le nœud, la policy elle-même (`tagOwners`/`grants`) reste manuelle dans la console
admin Tailscale.

Dans tous les cas, **aucun port n'est publié sur l'hôte** : l'entrée passe par le sidecar
Tailscale, ou par le réseau Docker que Traefik partage.

### Hors périmètre, assumé

Buildpacks et détection de stack (**le `Dockerfile` est à toi**), migrations et sauvegarde
des données, orchestration multi-serveur, comptes utilisateurs, métriques. Fournir ou
configurer le Traefik d'une cible publique : DBox ne fait que poser des labels sur ses
propres conteneurs. Les applications multi-conteneurs riches (`depends_on` conditionnel,
compagnon construit depuis un `Dockerfile`) : au-delà d'`image` et `data`, on écrit son
propre Compose.

### À venir

- **`ssh_port` combiné à `public_domain`** — refusé pour l'instant.

---

## Choix techniques

- **Node / TypeScript, zéro dépendance à l'exécution.** Node 24 exécute le TS nativement ;
  `node:test` pour les tests. `typescript`/`@types/node` existent en devDependencies (pour
  `tsc --noEmit`, jamais pour générer le JS exécuté), et le tableau de bord vendorise htmx et
  Alpine (`src/vendor/`, pas de CDN) — rien de tout ça n'est un paquet chargé au runtime du
  daemon.
- **DBox tourne lui-même en conteneur**, avec `/var/run/docker.sock` monté. Pas de base de
  données : son état est le système de fichiers (voir « Le registre »). Son installation est
  un `docker compose up -d`, et il revient au boot.
- **Source d'une app** : un dossier sur la machine, ou un dépôt git que DBox clone
  lui-même (`dbox add`) et tire avant chaque redéploiement.

---

## Prérequis

Une **clé d'authentification Tailscale réutilisable et taguée `tag:dbox`**, et la déclaration
du tag dans la politique du tailnet :

```json
{
  "tagOwners": {
    "tag:dbox": ["autogroup:admin"]
  }
}
```

Le tag n'est pas optionnel : un nœud non tagué expire au bout de 90 jours, et les apps
tombent du tailnet sans prévenir.

## Pièges connus

DBox existe en partie pour les absorber. Les voici, pour mémoire.

- **HMR derrière un proxy HTTPS.** Deux réglages, sinon ça casse au premier chargement :
  ajouter le nom tailnet à `server.allowedHosts`, et forcer
  `server.hmr = { protocol: 'wss', clientPort: 443 }` — sans quoi le client HMR tente de se
  reconnecter en clair sur le mauvais port.
- **Le serveur de dev doit écouter sur `0.0.0.0`** (`server.host: true` chez Vite), sinon il
  est injoignable depuis l'extérieur du conteneur.
- **Fichiers créés en `root`** en mode `devcontainer` : le compose généré porte l'UID de
  l'utilisateur en dur.
- **Double arbre de dépendances** en mode `devcontainer` : un volume masque `node_modules`
  pour éviter que les modules natifs compilés sur l'hôte ne cassent dans le conteneur.
  Préférer une image `bookworm-slim` plutôt qu'alpine — même libc que l'hôte Ubuntu.
- **Installer une dépendance** en mode `devcontainer` se fait dans le conteneur
  (`dbox exec budget npm i …`), pas sur l'hôte.

Ce qui ne s'applique **pas** sur Linux, contrairement à ce qu'on lit : la lenteur des
bind-mounts et le watch qui ne détecte rien. Ce sont des problèmes de VM, donc de macOS et
Windows. Ici `inotify` traverse le bind-mount nativement.
