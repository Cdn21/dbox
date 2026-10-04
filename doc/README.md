# Documentation de DBox

Toute la documentation du projet vit ici. Chaque document a un lecteur et une
question ; aucun ne répète ce qu'un autre couvre déjà.

| Document | Pour qui | Répond à |
| --- | --- | --- |
| [`GUIDE.md`](GUIDE.md) | Qui découvre DBox | À quoi ça sert, quel mode pour quel besoin, cas d'usage concrets. |
| [`INSTALL.md`](INSTALL.md) | Qui l'installe pour la première fois | Réseau Tailscale de zéro, installation, première app, dépannage. |
| [`REFERENCE.md`](REFERENCE.md) | Qui s'en sert au quotidien | Le modèle, le manifeste complet, les commandes, ce qui est généré, les pièges connus. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Qui lit ou modifie le code | Couches et modules, processus, données, déploiement, sécurité, décisions d'architecture. |
| [`UML.md`](UML.md) | Idem | Diagrammes : contexte, composants, classes, séquences, états, déploiement. |
| [`VENDOR.md`](VENDOR.md) | Qui met à jour htmx ou Alpine | Versions vendorisées et marche à suivre. |
| [`CHANGELOG.md`](CHANGELOG.md) | Qui met à jour DBox | Ce qui change d'une version à l'autre — en anglais, comme le README. |

Restent à la racine du dépôt, par convention :

- `README.md` — la page d'accueil, **en anglais** : présentation et démarrage
  rapide pour qui découvre le projet depuis l'extérieur. Elle renvoie ici pour
  tout le reste.
- `CONTRIBUTING.md` — notes de contribution : invariants protégés par les
  tests, contraintes du code, carte des modules.
- `LICENSE`.
