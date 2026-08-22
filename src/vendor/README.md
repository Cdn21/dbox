Bibliothèques JS servies telles quelles par le daemon, jamais chargées
depuis un CDN — cohérent avec l'invariant « aucune ressource externe ».

- `htmx.min.js` — [htmx](https://htmx.org) 2.0.10
- `alpine.min.js` — [Alpine.js](https://alpinejs.dev) 3.x (`cdn.min.js`)

Pour mettre à jour : remplacer le fichier par la nouvelle version minifiée,
rien d'autre à changer — `src/vendor.ts` les lit tels quels.
