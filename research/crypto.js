/* People Map crypto — must stay in lockstep with tools/encrypt.py
   AES-256-GCM, PBKDF2-HMAC-SHA256, 600000 iterations, 16-byte salt, 12-byte IV.
   The passphrase is never written to disk or localStorage. */
const PeopleCrypto = (() => {
  const ITER = 600000;
  const ALG = "AES-256-GCM";
  const KDF = "PBKDF2-SHA256";

  const b64 = (bytes) => {
    let s = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  };
  const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(passphrase, salt, iterations) {
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function decrypt(blob, passphrase) {
    if (!(window.crypto && crypto.subtle)) {
      throw new Error("This browser cannot decrypt here (needs https or localhost).");
    }
    if (!blob || !blob.ct || !blob.salt || !blob.iv) {
      throw new Error("No encrypted data found.");
    }
    const iterations = Number(blob.iter) || ITER;
    const key = await deriveKey(passphrase, ub64(blob.salt), iterations);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ub64(blob.iv) },
      key,
      ub64(blob.ct)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function encrypt(graph, passphrase) {
    if (!(window.crypto && crypto.subtle)) {
      throw new Error("This browser cannot encrypt here (needs https or localhost).");
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, ITER);
    const pt = new TextEncoder().encode(JSON.stringify(graph));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
    return {
      v: 1,
      alg: ALG,
      kdf: KDF,
      iter: ITER,
      salt: b64(salt),
      iv: b64(iv),
      ct: b64(ct),
    };
  }

  return { ITER, ALG, KDF, decrypt, encrypt };
})();
