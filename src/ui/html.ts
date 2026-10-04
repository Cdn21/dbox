/**
 * Les primitives de rendu : échapper, et nommer.
 *
 * `escape` garde l'invariant 8 — tout ce qui vient du disque passe par ici
 * avant d'entrer dans la page. Les deux autres fabriquent des identifiants DOM
 * stables à partir d'un couple app/cible.
 */

export function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "-");
}

export
function domId(app: string, target: string): string {
  return `${slug(app)}-${slug(target)}`;
}
