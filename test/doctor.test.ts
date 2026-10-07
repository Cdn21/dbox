import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aDesBloquants, diagnostic, formaterTexte, type Constat, type DoctorDeps } from "../src/doctor.ts";
import { route, type Deps } from "../src/server.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const CLE = "tskey-auth-kAbCdEf123-SECRETSECRETSECRET";

function machine(over: Partial<DoctorDeps> = {}, fichiers: Record<string, string> = {}): DoctorDeps {
  const disque: Record<string, string> = { "/k/authkey": `${CLE}\n`, "/k/authkey.expires": "2026-11-07\n", ...fichiers };
  return {
    tailnet: "exemple.ts.net",
    tsTag: "tag:dbox",
    root: "/k/apps",
    authkeyFile: "/k/authkey",
    configPresente: true,
    docker: async () => ({ ok: true, detail: "Docker 29.8.1" }),
    readFile: async (p) => {
      const v = disque[p];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    permissions: async () => 0o600,
    ecrivable: async () => true,
    espaceLibre: async () => 300 * 1024 ** 3,
    magicDns: async () => true,
    cibles: async () => [{ label: "budget · prod", url: "https://budget.exemple.ts.net" }],
    probe: async () => 200,
    resoudre: async () => true,
    tagReport: async () => ({ checkedAt: "2026-10-04T06:00:00Z", tag: "tag:dbox", present: true, suggestedLine: null }),
    now: () => NOW,
    ...over,
  };
}

const sujet = (cs: Constat[], s: string) => cs.filter((c) => c.sujet === s);
const un = (cs: Constat[], s: string) => {
  const trouves = sujet(cs, s);
  assert.equal(trouves.length, 1, `un seul constat « ${s} » attendu, ${trouves.length} trouvés`);
  return trouves[0]!;
};

describe("dbox doctor", () => {
  it("une machine prête : tout est bon, rien de bloquant", async () => {
    const cs = await diagnostic(machine());
    assert.deepEqual(
      cs.map((c) => `${c.sujet}:${c.niveau}`),
      ["Docker:ok", "Tailnet:ok", "Clé Tailscale:ok", "Réseau privé:ok", "HTTPS:ok", "Tag ACL:ok", "Racine:ok", "Espace disque:ok"],
    );
    assert.equal(aDesBloquants(cs), false);
    assert.match(formaterTexte(cs), /tout est prêt\n$/);
  });

  it("ne recopie jamais la valeur de la clé, quel que soit le constat", async () => {
    const cas = [
      machine(),
      machine({}, { "/k/authkey": `${CLE}\nchmod 600 /k/authkey\n` }),
      machine({}, { "/k/authkey": "tskey-api-SECRETSECRETSECRET\n" }),
    ];
    for (const m of cas) {
      const texte = formaterTexte(await diagnostic(m));
      assert.doesNotMatch(texte, /SECRET/);
    }
  });

  it("Docker injoignable : bloquant, avec la marche à suivre", async () => {
    const c = un(await diagnostic(machine({ docker: async () => ({ ok: false, detail: "permission denied" }) })), "Docker");
    assert.equal(c.niveau, "bloquant");
    assert.match(c.correction ?? "", /groupe docker/);
  });

  it("tailnet absent : bloquant, et le contrôle réseau n'est même pas tenté", async () => {
    let tente = false;
    const cs = await diagnostic(machine({ tailnet: undefined, magicDns: async () => ((tente = true), true) }));
    assert.equal(un(cs, "Tailnet").niveau, "bloquant");
    assert.equal(tente, false);
    assert.equal(sujet(cs, "Réseau privé").length, 0);
  });

  it("configuration absente en CLI : à surveiller, avec dbox setup", async () => {
    const c = un(await diagnostic(machine({ configPresente: false })), "Configuration");
    assert.equal(c.niveau, "attention");
    assert.equal(c.correction, "dbox setup");
  });

  describe("la clé d'authentification", () => {
    const cle = async (fichiers: Record<string, string>, over: Partial<DoctorDeps> = {}) =>
      sujet(await diagnostic(machine(over, fichiers)), "Clé Tailscale");

    it("absente : bloquant, et la correction sépare l'écriture du chmod", async () => {
      const [c] = await cle({}, { readFile: async () => Promise.reject(new Error("ENOENT")) });
      assert.equal(c!.niveau, "bloquant");
      assert.match(c!.correction ?? "", /puis, dans une commande séparée, chmod 600/);
    });

    it("avec du texte en trop (le chmod collé dans le fichier) : bloquant", async () => {
      const [c] = await cle({ "/k/authkey": `${CLE}\nchmod 600 ~/dbox/authkey\n` });
      assert.equal(c!.niveau, "bloquant");
      assert.match(c!.message, /2 lignes/);
    });

    it("une clé d'API au lieu d'une clé d'authentification : bloquant", async () => {
      const [c] = await cle({ "/k/authkey": "tskey-api-abc123\n" });
      assert.equal(c!.niveau, "bloquant");
      assert.match(c!.message, /pas une clé d'authentification/);
    });

    it("vide : bloquant", async () => {
      assert.equal((await cle({ "/k/authkey": "  \n" }))[0]!.niveau, "bloquant");
    });

    it("lisible par d'autres : à surveiller, chmod 600", async () => {
      const cs = await cle({}, { permissions: async () => 0o644 });
      const perm = cs.find((c) => c.niveau === "attention");
      assert.match(perm?.correction ?? "", /chmod 600/);
    });

    it("échéance : expirée bloque, sous 14 jours prévient, au-delà rassure", async () => {
      assert.equal((await cle({ "/k/authkey.expires": "2026-09-30\n" }))[0]!.niveau, "bloquant");
      assert.equal((await cle({ "/k/authkey.expires": "2026-10-10\n" }))[0]!.niveau, "attention");
      assert.match((await cle({}))[0]!.message, /expire dans 34 j/);
    });
  });

  it("hors du tailnet : bloquant, car le contrôle de santé passe par l'adresse finale", async () => {
    const c = un(await diagnostic(machine({ magicDns: async () => false })), "Réseau privé");
    assert.equal(c.niveau, "bloquant");
    assert.match(c.correction ?? "", /tailscale up/);
  });

  describe("HTTPS", () => {
    it("sans app déployée : une simple information", async () => {
      assert.equal(un(await diagnostic(machine({ cibles: async () => [] })), "HTTPS").niveau, "info");
    });

    it("aucune app ne répond alors que leurs noms se résolvent : piste des certificats", async () => {
      const c = un(await diagnostic(machine({ probe: async () => null })), "HTTPS");
      assert.equal(c.niveau, "attention");
      assert.match(c.correction ?? "", /HTTPS Certificates/);
    });

    it("les noms du tailnet ne se résolvent pas ici : bloquant, piste du DNS (le bug du lanceur)", async () => {
      const c = un(await diagnostic(machine({ probe: async () => null, resoudre: async () => false })), "HTTPS");
      assert.equal(c.niveau, "bloquant");
      assert.match(c.message, /ne se résolvent pas/);
      assert.match(c.correction ?? "", /install\.sh/);
    });

    it("une partie seulement : nomme celles qui se taisent", async () => {
      const cibles = async () => [
        { label: "a · prod", url: "https://a.exemple.ts.net" },
        { label: "b · prod", url: "https://b.exemple.ts.net" },
      ];
      const c = un(await diagnostic(machine({ cibles, probe: async (u) => (u.includes("//b.") ? null : 200) })), "HTTPS");
      assert.equal(c.niveau, "attention");
      assert.match(c.message, /b · prod/);
      assert.doesNotMatch(c.message, /a · prod/);
    });
  });

  describe("tag ACL", () => {
    it("absent selon le rapport du rotator : bloquant, avec la ligne à coller", async () => {
      const tagReport = async () => ({ checkedAt: "x", tag: "tag:dbox", present: false, suggestedLine: '"tag:dbox": ["autogroup:admin"],' });
      const c = un(await diagnostic(machine({ tagReport })), "Tag ACL");
      assert.equal(c.niveau, "bloquant");
      assert.match(c.correction ?? "", /"tag:dbox": \["autogroup:admin"\]/);
    });

    it("sans rapport, la CLI lit tagOwners en direct si on lui en donne le moyen", async () => {
      const c = un(
        await diagnostic(machine({ tagReport: async () => null, tagOwners: async () => ({ "tag:autre": [] }) })),
        "Tag ACL",
      );
      assert.equal(c.niveau, "bloquant");
    });

    it("sans rapport ni token (le daemon) : une information, jamais un appel à l'API", async () => {
      const c = un(await diagnostic(machine({ tagReport: async () => null })), "Tag ACL");
      assert.equal(c.niveau, "info");
    });

    it("un rapport portant sur un autre tag n'est pas cru", async () => {
      const tagReport = async () => ({ checkedAt: "x", tag: "tag:autre", present: true, suggestedLine: null });
      assert.equal(un(await diagnostic(machine({ tagReport })), "Tag ACL").niveau, "info");
    });
  });

  it("racine non accessible et disque presque plein : bloquants", async () => {
    const cs = await diagnostic(machine({ ecrivable: async () => false, espaceLibre: async () => 1024 ** 3 }));
    assert.equal(un(cs, "Racine").niveau, "bloquant");
    assert.equal(un(cs, "Espace disque").niveau, "bloquant");
    assert.match(formaterTexte(cs), /2 bloquants\n$/);
  });

  it("un effet qui lève ne fait pas tomber le diagnostic", async () => {
    const cs = await diagnostic(
      machine({
        docker: async () => Promise.reject(new Error("socket absent")),
        magicDns: async () => Promise.reject(new Error("x")),
        cibles: async () => Promise.reject(new Error("x")),
      }),
    );
    assert.equal(un(cs, "Docker").niveau, "bloquant");
    assert.equal(un(cs, "Réseau privé").niveau, "bloquant");
    assert.equal(un(cs, "HTTPS").niveau, "info");
  });
});

describe("le diagnostic dans le tableau de bord", () => {
  const MOI = { "tailscale-user-login": "moi@exemple.fr" };
  const base: Deps = { scan: async () => [], now: () => NOW, actions: undefined };

  it("absent du daemon : ni panneau, ni route", async () => {
    assert.doesNotMatch((await route("GET", "/settings", MOI, base)).body, /id="resultat-diagnostic"/);
    assert.equal((await route("GET", "/api/diagnostic", MOI, base)).status, 404);
  });

  it("présent : un bouton, puis un fragment échappé — en GET, sans en-tête d'action", async () => {
    const deps: Deps = {
      ...base,
      diagnostic: async () => [{ sujet: "Docker", niveau: "bloquant", message: "<script>x</script>", correction: "a & b" }],
    };
    assert.match((await route("GET", "/settings", MOI, deps)).body, /hx-get="\/api\/diagnostic"/);
    const r = await route("GET", "/api/diagnostic", MOI, deps);
    assert.equal(r.status, 200);
    assert.match(r.body, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.match(r.body, /→ a &amp; b/);
    assert.match(r.body, /1 bloquant/);
    // Lecture seule : sans identité, rien.
    assert.equal((await route("GET", "/api/diagnostic", {}, deps)).status, 401);
  });
});

describe("dbox doctor — backend Headscale", () => {
  const hs = (over: Partial<DoctorDeps> = {}, fichiers: Record<string, string> = {}) =>
    machine(
      {
        backend: "headscale",
        tailnet: "tailnet.appvc.fr",
        headscaleLoginServer: "https://headscale.appvc.fr",
        headscaleCertDir: "/certs",
        headscaleAuthkeyFile: "/k/hs-authkey",
        certExpiry: async () => "2027-06-01", // loin
        ...over,
      },
      { "/k/hs-authkey": "hskey-xxx\n", ...fichiers },
    );

  it("tout en place : serveur, clé et certificat au vert", async () => {
    const cs = await diagnostic(hs());
    assert.equal(un(cs, "Headscale").niveau, "ok");
    assert.equal(un(cs, "Clé Headscale").niveau, "ok");
    assert.equal(un(cs, "Certificat").niveau, "ok");
  });

  it("serveur injoignable = bloquant", async () => {
    const cs = await diagnostic(hs({ probe: async (u) => (u.includes("headscale.appvc.fr") ? null : 200) }));
    assert.equal(un(cs, "Headscale").niveau, "bloquant");
  });

  it("clé préauth absente = bloquant", async () => {
    const cs = await diagnostic(hs({}, { "/k/hs-authkey": "" }));
    assert.equal(un(cs, "Clé Headscale").niveau, "bloquant");
  });

  it("certificat absent/illisible = bloquant, avec le nom attendu en correction", async () => {
    const cs = await diagnostic(hs({ certExpiry: async () => null }));
    const c = un(cs, "Certificat");
    assert.equal(c.niveau, "bloquant");
    assert.match(c.correction ?? "", /tailnet\.appvc\.fr\.crt/);
  });

  it("certificat proche de l'échéance = attention ; expiré = bloquant", async () => {
    const proche = await diagnostic(hs({ certExpiry: async () => "2026-10-20" })); // NOW = 2026-10-04
    assert.equal(un(proche, "Certificat").niveau, "attention");
    const expire = await diagnostic(hs({ certExpiry: async () => "2026-09-01" }));
    assert.equal(un(expire, "Certificat").niveau, "bloquant");
  });

  it("image-sonde absente : certificat non vérifiable, mais pas bloquant", async () => {
    const cs = await diagnostic(hs({ certExpiry: undefined }));
    assert.equal(un(cs, "Certificat").niveau, "info");
  });

  it("backend non headscale : aucun constat Headscale/Certificat", async () => {
    const cs = await diagnostic(machine()); // backend undefined
    assert.equal(sujet(cs, "Headscale").length, 0);
    assert.equal(sujet(cs, "Certificat").length, 0);
    assert.equal(sujet(cs, "Clé Headscale").length, 0);
  });
});
