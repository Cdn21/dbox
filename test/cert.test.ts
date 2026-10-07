import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { certExpiryFromPem, certNotice, certPath, readCertExpiry } from "../src/cert.ts";

// Certificat auto-signé jetable, notAfter figé au 2036-10-04 (openssl -days 3650).
const CERT = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUVu1MH7VoIBXVPxV7UZm9uGV9nb4wDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMdGVzdC5leGVtcGxlMB4XDTI2MTAwNzA4NTEwMloXDTM2
MTAwNDA4NTEwMlowFzEVMBMGA1UEAwwMdGVzdC5leGVtcGxlMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt3H/LaO5EWLmtTE0mwCPU3w8tH63GiZusGgQ
SMiAfQ3Fs+R980gq3Pjwu2J8OxftFd4UWJRYxOfPkAYTSElnF129Vr3VK0idVs0q
bTcTnuk9Otjqk9TkQZVpFUenWoHzfgwRX6CU7LIkp82r0ru6PbWwCD0uOHSCFG9j
FJAIysG/YbSa71Sl2mxh2gg5CT5TVGBSXPpuVY9wMdXCe6dPiOiaGuC3lKYmMTpT
iUWCIxrXjf+fmXBLzoaMiEPhgvc4sE5hOmHOPqRlw2THPre0k8Ov+CSn1meCKG2+
cbkrVCJgZB8INaZ7qgGtq32uK+Xp5b5JTlv3ayInhzBVOCucIwIDAQABo1MwUTAd
BgNVHQ4EFgQUaxbYa9tnzoOBljMh2mHkd8tmFEEwHwYDVR0jBBgwFoAUaxbYa9tn
zoOBljMh2mHkd8tmFEEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAYyiobacXNZDfsAf0zA01WYnrPkurKcGQNKxEi6jjmjtnWxaaX8ixQ4vS0KeC
0CvijP18bwE0zAr9ARacCtTw/BC6p4EiuGnLPLxba2UzRgQTpmReYo2DLbnAKFZP
j+9CvQ4S50CJftwd7h1fT9pBUs5bzMrUT25rwUCwW2iU+b5NxG0tqtTmkocv08vJ
EjinNgM4xDYVD1rjac/f1/optI7ow4kL7kHcIGzs913T/tmWuMf40e0kBMN0LnD8
7NJ8iNx3FdGMEOXXACJPI0wE2VoghRjOcTM4/mJGmc1Q2RCA9/aacO+n+eQ3kD3k
eR0afEYOhm4uveN+bG73OgG5ow==
-----END CERTIFICATE-----`;

describe("cert : expiration", () => {
  it("lit le notAfter d'un vrai certificat, en ISO", () => {
    assert.equal(certExpiryFromPem(CERT), "2036-10-04");
  });

  it("un PEM illisible rend null, jamais une exception", () => {
    assert.equal(certExpiryFromPem("pas un certificat"), null);
    assert.equal(certExpiryFromPem(""), null);
  });

  it("le certificat suit le domaine, pas le nom d'hôte", () => {
    assert.equal(certPath("tailnet.appvc.fr"), "tailnet.appvc.fr.crt");
  });

  it("readCertExpiry monte le dossier en lecture seule et lance __certexpiry", async () => {
    const vus: string[][] = [];
    const iso = await readCertExpiry("/srv/certs", "tailnet.appvc.fr", "dbox:img", async (file, args) => {
      vus.push([file, ...args]);
      return { code: 0, stdout: "2027-06-01\n", stderr: "" };
    });
    assert.equal(iso, "2027-06-01");
    assert.deepEqual(vus[0], [
      "docker",
      "run",
      "--rm",
      "-v",
      "/srv/certs:/certs:ro", // dossier hôte, lecture seule
      "dbox:img",
      "__certexpiry",
      "/certs/tailnet.appvc.fr.crt",
    ]);
  });

  it("une sortie non datée (cert illisible dans le conteneur) rend null", async () => {
    const iso = await readCertExpiry("/c", "t.ts.net", "img", async () => ({ code: 1, stdout: "null", stderr: "" }));
    assert.equal(iso, null);
  });

  it("certNotice calcule les jours restants", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    assert.deepEqual(certNotice("2026-10-14", now), { expiresOn: "2026-10-14", daysLeft: 10 });
  });
});
