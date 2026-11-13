/* Save the encrypted research file to GitHub from the browser.
   Uses the Contents API on Rudz1/rudi-dashboard (branch main, path research/data.enc.json).
   The GitHub token is never written into this file. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResearchSave = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIG = {
    owner: "Rudz1",
    repo: "rudi-dashboard",
    path: "research/data.enc.json",
    branch: "main",
    tokenLsKey: "people-map-gh-token-enc",
    tokenCreateUrl:
      "https://github.com/settings/personal-access-tokens/new?name=Research+save&description=Save+the+encrypted+research+file+to+the+rudi-dashboard+repo+only&target_name=Rudz1&expires_in=366&contents=write",
    tokenSettingsUrl: "https://github.com/settings/personal-access-tokens",
  };

  function apiUrl() {
    return "https://api.github.com/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + CONFIG.path;
  }

  function headers(token) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function encodeContent(text) {
    const str = String(text);
    if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
    const bytes = new TextEncoder().encode(str);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function decodeContent(b64) {
    const clean = String(b64 || "").replace(/\s/g, "");
    if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("utf8");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function safeJson(res) {
    try { return await res.json(); } catch (e) { return null; }
  }

  function isShaConflict(status, body) {
    if (status === 409) return true;
    if (status === 422) {
      const msg = String((body && (body.message || body)) || "").toLowerCase();
      return /sha|conflict|does not match|is at /.test(msg);
    }
    return false;
  }

  function githubError(res, body, action) {
    const verb = action || "talk to GitHub";
    if (res.status === 401 || res.status === 403) {
      return new Error("The GitHub token was refused. Open Connect saving and paste a new one.");
    }
    if (res.status === 404) {
      return new Error("Could not find the research file in the GitHub repo.");
    }
    const detail = body && body.message ? " " + body.message : " GitHub returned " + res.status + ".";
    return new Error("Could not " + verb + "." + detail);
  }

  function commitMessage(when) {
    const t = when instanceof Date ? when : new Date();
    return "Research: save from board " + t.toISOString();
  }

  async function getRemoteFile(token, fetchFn) {
    const fetchImpl = fetchFn || fetch;
    const url = apiUrl() + "?ref=" + encodeURIComponent(CONFIG.branch);
    const res = await fetchImpl(url, { headers: headers(token), cache: "no-store" });
    const body = await safeJson(res);
    if (!res.ok) throw githubError(res, body, "load the online file");
    const text = decodeContent(body && body.content);
    let blob;
    try { blob = JSON.parse(text); } catch (e) {
      throw new Error("The online file was not valid encrypted JSON.");
    }
    if (!blob || !blob.ct || !blob.salt || !blob.iv) {
      throw new Error("The online file was not a valid encrypted payload.");
    }
    return { sha: body.sha, text, blob };
  }

  async function putRemoteFile(token, text, fetchFn, now) {
    const fetchImpl = fetchFn || fetch;
    const url = apiUrl();
    const message = commitMessage(now);
    const content = encodeContent(text);

    async function readSha() {
      const res = await fetchImpl(url + "?ref=" + encodeURIComponent(CONFIG.branch), {
        headers: headers(token),
        cache: "no-store",
      });
      if (res.status === 404) return null;
      const body = await safeJson(res);
      if (!res.ok) throw githubError(res, body, "read the online file");
      return body && body.sha ? body.sha : null;
    }

    async function attempt(sha) {
      const payload = { message, content, branch: CONFIG.branch };
      if (sha) payload.sha = sha;
      return fetchImpl(url, {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, headers(token)),
        body: JSON.stringify(payload),
      });
    }

    let sha = await readSha();
    let res = await attempt(sha);
    let body = await safeJson(res);
    if (isShaConflict(res.status, body)) {
      sha = await readSha();
      res = await attempt(sha);
      body = await safeJson(res);
      if (!res.ok) {
        throw new Error("Could not save online because the file changed at the same time. Wait a moment and try again.");
      }
      return { result: body, retried: true, message };
    }
    if (!res.ok) throw githubError(res, body, "save online");
    return { result: body, retried: false, message };
  }

  async function wrapToken(token, passphrase, encryptFn) {
    const cleaned = String(token || "").trim();
    if (!cleaned) throw new Error("Paste a GitHub token first.");
    return encryptFn({ token: cleaned }, passphrase);
  }

  async function unwrapToken(blob, passphrase, decryptFn) {
    const obj = await decryptFn(blob, passphrase);
    const t = obj && obj.token;
    if (!t || typeof t !== "string") throw new Error("No token");
    return t;
  }

  function graphTime(graph) {
    const raw = graph && graph.updated;
    if (!raw) return 0;
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : 0;
  }

  return {
    CONFIG,
    apiUrl,
    headers,
    encodeContent,
    decodeContent,
    isShaConflict,
    commitMessage,
    getRemoteFile,
    putRemoteFile,
    wrapToken,
    unwrapToken,
    graphTime,
  };
});
