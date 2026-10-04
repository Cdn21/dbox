# Installer DBox

Guide pour quelqu'un qui découvre l'outil. Pour comprendre *comment* DBox
pense — modes, manifeste, arbitrages — voir [`REFERENCE.md`](REFERENCE.md), plus en profondeur.

Il te faut être à l'aise avec un terminal.

## Avant de commencer

- **Une machine Linux** (Ubuntu ou proche) où tu peux lancer des commandes.
- **Docker**, installé et utilisable sans `sudo` —
  [docs.docker.com/engine/install](https://docs.docker.com/engine/install/)
  si besoin.
- **Tailscale installé et connecté sur cette même machine.** DBox vérifie
  chaque app en interrogeant son adresse finale : si la machine n'est pas
  elle-même sur ton réseau privé, chaque déploiement échoue au contrôle de
  santé, alors que l'app tourne.

## 1. Ton réseau privé

DBox s'appuie sur [Tailscale](https://tailscale.com) pour créer ce réseau
privé — gratuit, et c'est lui qui donne à chaque app son nom et son
certificat HTTPS, automatiquement.

Crée un compte, puis dans **DNS**, active **MagicDNS** et **HTTPS
Certificates** : sans eux, aucune app n'obtient de certificat, et la première
ne démarrera jamais.

Ensuite, dans **Access controls → Definitions → Tags**, crée
deux tags — propriétaire `autogroup:admin` pour les deux :

- `tag:dbox` — porté par chaque app que tu déploies
- `tag:dbox-admin` — porté par le tableau de bord, si tu l'utilises un jour

Ensuite, **Access controls → JSON editor** : restreins l'accès à tes propres
appareils, pour qu'une app ne puisse jamais en atteindre une autre.

```json
"grants": [
  {
    "src": ["autogroup:member"],
    "dst": ["*"],
    "ip":  ["*"]
  }
]
```

Enfin, **Settings → Keys → Generate auth key** : coche *Reusable*, décoche
*Ephemeral*, tag `tag:dbox`. Garde la valeur sous la main pour l'étape 2.

## 2. Installer et configurer

Le seul vrai prérequis est Docker : la commande `dbox` tourne elle-même dans
un conteneur, tu n'as rien d'autre à installer.

```bash
git clone <url-du-dépôt> dbox
cd dbox
./install.sh
```

`install.sh` vérifie Docker, construit l'image, pose la commande `dbox` dans
`~/.local/bin` — puis te propose d'enchaîner tout de suite sur
`dbox setup`, quatre questions qui écrivent la configuration de cette
machine (tailnet, cible, racine, tag).

`setup` ne te demande jamais la clé Tailscale elle-même — il affiche
exactement où la coller. C'est la seule étape à faire à la main, et
volontairement : un secret ne doit passer par aucun outil susceptible de le
garder en mémoire.

```bash
echo 'COLLE-TA-CLE-ICI' > ~/dbox/authkey
```

**Piège classique :** colle la clé *à la place* de `COLLE-TA-CLE-ICI`, pas à
côté — un espace ou un texte en trop dans ce fichier, et la clé est refusée
sans message clair.

## 3. Déployer ta première app

Il te faut un dossier avec un `Dockerfile` — DBox ne le devine jamais, c'est
le seul fichier qui décrit vraiment ton app. Le reste tient en une commande,
qu'il existe déjà un manifeste ou non :

```bash
dbox up ~/chemin/vers/ton-app
```

Sans `dbox.toml`, `up` en déduit un du dossier et du Dockerfile (nom, port)
avant de construire, démarrer, et vérifier que l'app répond.

Le code est déjà sur GitHub ? Une seule commande clone, prépare et déploie :

```bash
dbox add git@github.com:toi/ton-app.git
```

**✓ Ça marche** quand la dernière ligne de `dbox up` affiche
`en ligne · https://ton-app.tontailnet.ts.net` — ouvre cette adresse depuis
n'importe quel appareil connecté à ton réseau privé.

## Optionnel — le tableau de bord web

Une page qui liste tes apps, avec un bouton pour redéployer, arrêter, lire
les journaux — accessible depuis ton téléphone. C'est une étape à part :
elle donne à DBox un accès complet à Docker sur cette machine, donc mieux
vaut la lire en conscience plutôt que la lancer en réflexe. Marche à
suivre : `deploy/docker-compose.yml` dans le dépôt.

## En cas de blocage

**« invalid key » ou l'app ne devient jamais joignable**
Vérifie `~/dbox/authkey` : rien d'autre que la clé, aucun texte du modèle
laissé autour (voir l'aparté de l'étape 2).

**Le premier démarrage dépasse les 180 secondes**
Vérifie d'abord que les certificats HTTPS sont activés dans les réglages DNS
du tailnet (étape 1). Sinon, c'est normal à l'occasion — le certificat HTTPS
met parfois un peu de temps à être délivré. `dbox up` te dira où regarder si ça persiste :
`docker logs <projet>-tailscale-1`.

**Le contrôle de santé échoue alors que l'app tourne**
La machine qui exécute DBox doit être sur le tailnet (`tailscale status`).

**`docker: command not found` ou accès refusé au socket**
Docker doit être installé *et* utilisable sans `sudo` — ajoute ton
utilisateur au groupe `docker`, puis rouvre ta session.

**Le port deviné par `dbox init` est faux**
Édite simplement le `dbox.toml` généré — c'est un fichier texte ordinaire,
une proposition de départ, pas une vérité figée.
