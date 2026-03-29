/**
 * NotebookLM Unofficial API Client
 * Basé sur notebooklm-py (https://github.com/teng-lin/notebooklm-py)
 * Utilise les cookies du navigateur actuel pour l'auth.
 * Supporte plusieurs comptes Google via authuser=N.
 */

const BATCHEXECUTE_URL = "https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute";
const NOTEBOOKLM_HOME = "https://notebooklm.google.com/";
const UPLOAD_URL = "https://notebooklm.google.com/upload/_/";

const RPC = {
  LIST_NOTEBOOKS: "wXbhsf",
  GET_NOTEBOOK: "rLM1Ne",
  ADD_SOURCE: "izAoDd",       // Ajoute une URL comme source
  ADD_SOURCE_FILE: "o4cbdc",  // Enregistre un fichier uploadé comme source
};

// ─── Multi-account support ────────────────────────────────────────────────────

let _currentAuthUser = 0;

/** Cache par authuser index: { csrf, sessionId } */
const _tokenCache = new Map();
/** Cache des emails par authuser index */
const _emailCache = new Map();

/**
 * Change le compte actif. Appelé depuis le service worker quand l'utilisateur
 * sélectionne un compte.
 */
export function setAuthUser(authuser) {
  _currentAuthUser = authuser;
}

export function getAuthUser() {
  return _currentAuthUser;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Récupère les tokens CSRF pour un authuser donné.
 * @param {boolean} forceRefresh
 * @param {number} authuser - Index du compte Google (0, 1, 2…)
 */
export async function getAuthTokens(forceRefresh = false, authuser = _currentAuthUser) {
  if (_tokenCache.has(authuser) && !forceRefresh) return _tokenCache.get(authuser);

  const url = new URL(NOTEBOOKLM_HOME);
  url.searchParams.set("authuser", authuser);

  const resp = await fetch(url.toString(), {
    credentials: "include",
    cache: "no-store",
  });

  if (!resp.ok) {
    throw new Error(`NotebookLM non accessible (${resp.status}). Êtes-vous connecté ?`);
  }

  const html = await resp.text();

  const csrfMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
  const sessionMatch = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
  const emailMatch = html.match(/"([a-zA-Z0-9._%+\-]{2,50}@[a-zA-Z0-9.\-]{2,30}\.[a-zA-Z]{2,10})"/);

  if (!csrfMatch) {
    throw new Error("CSRF token introuvable. Connectez-vous à NotebookLM d'abord.");
  }

  const tokens = {
    csrf: csrfMatch[1],
    sessionId: sessionMatch ? sessionMatch[1] : "",
  };

  _tokenCache.set(authuser, tokens);
  if (emailMatch) _emailCache.set(authuser, emailMatch[1]);

  return tokens;
}

/**
 * Retourne l'email du compte actif.
 */
export async function getUserEmail() {
  if (!_emailCache.has(_currentAuthUser)) {
    await getAuthTokens(true, _currentAuthUser);
  }
  return _emailCache.get(_currentAuthUser) || null;
}

/**
 * Détecte tous les comptes Google connectés qui ont accès à NotebookLM.
 * Teste authuser=0 à 3.
 * @returns {Array<{authuser: number, email: string}>}
 */
export async function detectAccounts() {
  const accounts = [];
  const checks = [0, 1, 2, 3].map(async (authuser) => {
    try {
      await getAuthTokens(true, authuser);
      const email = _emailCache.get(authuser);
      if (email) accounts.push({ authuser, email });
    } catch {
      // Ce compte n'est pas connecté ou n'a pas accès
    }
  });
  await Promise.all(checks);
  // Trier par authuser pour un ordre cohérent
  accounts.sort((a, b) => a.authuser - b.authuser);
  // Dédupliquer par email (même compte sur plusieurs index)
  const seen = new Set();
  return accounts.filter(a => {
    if (seen.has(a.email)) return false;
    seen.add(a.email);
    return true;
  });
}

// ─── RPC Core ─────────────────────────────────────────────────────────────────

/**
 * Effectue un appel RPC batchexecute vers NotebookLM.
 * @param {string} methodId - ID de la méthode RPC
 * @param {Array} params - Paramètres (seront JSON.stringify)
 * @param {string} sourcePath - Path pour le header source (ex: "/notebook/xyz")
 */
async function rpcCall(methodId, params, sourcePath = "/") {
  let tokens;
  try {
    tokens = await getAuthTokens();
  } catch (e) {
    throw new Error("AUTH_REQUIRED");
  }

  const encodedParams = JSON.stringify(params);
  const fReq = JSON.stringify([[[methodId, encodedParams, null, "generic"]]]);

  const url = new URL(BATCHEXECUTE_URL);
  url.searchParams.set("rpcids", methodId);
  url.searchParams.set("source-path", sourcePath);
  url.searchParams.set("f.sid", tokens.sessionId);
  url.searchParams.set("hl", "fr");
  url.searchParams.set("rt", "c");
  url.searchParams.set("authuser", _currentAuthUser);

  const body = new URLSearchParams();
  body.set("f.req", fReq);
  body.set("at", tokens.csrf);

  const resp = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://notebooklm.google.com",
      "Referer": "https://notebooklm.google.com/",
    },
    body: body.toString(),
  });

  if (resp.status === 401 || resp.status === 403) {
    // Refresh tokens et réessaye une fois
    _tokenCache.delete(_currentAuthUser);
    return rpcCall(methodId, params, sourcePath);
  }

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => "");
    throw new Error(`RPC ${methodId} HTTP ${resp.status}: ${errorBody.slice(0, 300)}`);
  }

  const text = await resp.text();
  return parseResponse(text, methodId);
}

/**
 * Parse la réponse batchexecute.
 * Format: )]}'\\n[chunks...]
 * On cherche le chunk wrb.fr avec notre methodId.
 */
function parseResponse(text, methodId) {
  // Supprimer le préfixe anti-XSSI
  const cleaned = text.replace(/^\)\]\}'\r?\n/, "");

  for (const line of cleaned.split("\n")) {
    if (!line.trim()) continue;
    try {
      const chunk = JSON.parse(line);
      // Cherche les chunks de type wrb.fr
      if (Array.isArray(chunk)) {
        for (const item of chunk) {
          if (Array.isArray(item) && item[0] === "wrb.fr" && item[1] === methodId) {
            if (item[2]) {
              return JSON.parse(item[2]);
            }
          }
        }
      }
    } catch {
      // Ligne non JSON, on continue
    }
  }

  // Fallback: essayer de parser tout le body comme JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      for (const chunk of parsed) {
        if (Array.isArray(chunk) && chunk[0] === "wrb.fr" && chunk[1] === methodId) {
          return chunk[2] ? JSON.parse(chunk[2]) : null;
        }
      }
    }
  } catch {
    // ignored
  }

  return null;
}

// ─── Notebooks ────────────────────────────────────────────────────────────────

/**
 * Liste tous les notebooks de l'utilisateur.
 * @returns {Array<{id, title}>}
 */
export async function listNotebooks() {
  // Format documenté par notebooklm-py (rpc-reference.md) :
  // params = [None, 1, None, [2]]
  const params = [null, 1, null, [2]];
  const data = await rpcCall(RPC.LIST_NOTEBOOKS, params);

  if (!data || !Array.isArray(data)) {
    return [];
  }

  // Structure de réponse (source: notebooklm-py types.py Notebook.from_api_response) :
  // nb[0] = titre (string), nb[2] = notebook ID (UUID)
  const notebooks = data[0] || [];
  return notebooks.map((nb) => {
    const rawTitle = (nb[0] && typeof nb[0] === "string") ? nb[0] : "";
    const title = rawTitle.replace("thought\n", "").trim() || "Sans titre";
    const id = (nb[2] && typeof nb[2] === "string") ? nb[2] : "";
    return { id, title };
  }).filter((nb) => nb.id);
}

/**
 * Vérifie si une URL est déjà enregistrée comme source dans un notebook.
 * Utilise GET_NOTEBOOK et cherche l'URL dans la réponse sérialisée.
 */
export async function isSourceSaved(notebookId, url) {
  const params = [notebookId, null, [2], null, 0];
  const data = await rpcCall(RPC.GET_NOTEBOOK, params, `/notebook/${notebookId}`);
  if (!data) return false;
  const normalized = normalizeUrl(url);
  // Cherche l'URL (ou sa version normalisée) dans la réponse JSON
  const str = JSON.stringify(data);
  return str.includes(normalized) || str.includes(url);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "") + u.search;
  } catch {
    return url;
  }
}

// ─── Sources ──────────────────────────────────────────────────────────────────

/**
 * Ajoute une URL comme source dans un notebook.
 * NotebookLM va crawler l'URL lui-même.
 * @param {string} notebookId
 * @param {string} url
 */
export async function addSourceUrl(notebookId, url) {
  const isYouTube = /^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(url);

  // YouTube : URL à la position [7] dans un array de 11 éléments
  // Autres   : URL à la position [0] dans un array de 6 éléments
  const sourceEntry = isYouTube
    ? [null, null, null, null, null, null, null, url, null, null, null]
    : [url, null, null, null, null, null];

  const params = [notebookId, [sourceEntry], null, null];
  return await rpcCall(RPC.ADD_SOURCE, params, `/notebook/${notebookId}`);
}

/**
 * Upload un PDF puis l'enregistre comme source dans un notebook.
 * Flux correct (d'après notebooklm-py/_sources.py) :
 *   1. ADD_SOURCE_FILE RPC → obtenir sourceId
 *   2. Démarrer session upload résumable avec sourceId → obtenir uploadUrl
 *   3. Uploader les bytes vers uploadUrl
 * @param {string} notebookId
 * @param {ArrayBuffer} pdfBuffer - Contenu du PDF
 * @param {string} filename - Nom du fichier
 */
export async function addSourcePdf(notebookId, pdfBuffer, filename) {
  // Étape 1 : enregistrer la source → obtenir sourceId
  const sourceId = await registerFileSource(notebookId, filename);

  // Étape 2 : démarrer une session upload résumable
  const uploadUrl = await startResumableUpload(notebookId, filename, sourceId, pdfBuffer.byteLength);

  // Étape 3 : envoyer les bytes du PDF
  await uploadFileBytes(uploadUrl, pdfBuffer);
}

/**
 * Étape 1 : ADD_SOURCE_FILE RPC — enregistre la source, retourne le sourceId.
 */
async function registerFileSource(notebookId, filename) {
  // Format extrait de notebooklm-py/_sources.py
  const params = [
    [[filename]],   // filename double-nesté
    notebookId,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];

  const data = await rpcCall(RPC.ADD_SOURCE_FILE, params, `/notebook/${notebookId}`);

  if (!data) throw new Error("ADD_SOURCE_FILE: réponse vide");

  // Extraire le sourceId depuis la réponse nestée
  const sourceId = extractSourceId(data);
  if (!sourceId) throw new Error("ADD_SOURCE_FILE: sourceId introuvable dans la réponse");
  return sourceId;
}

/**
 * Tente d'extraire un sourceId (UUID-like string) depuis une réponse nestée.
 */
function extractSourceId(data) {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    // Cherche récursivement un UUID dans les 3 premiers niveaux
    for (const item of data) {
      const found = extractSourceId(item);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Étape 2 : démarre une session d'upload résumable Google.
 * Retourne l'URL d'upload (header x-goog-upload-url de la réponse).
 */
async function startResumableUpload(notebookId, filename, sourceId, fileSize) {
  const url = new URL(UPLOAD_URL);
  url.searchParams.set("authuser", _currentAuthUser);

  const body = JSON.stringify({
    PROJECT_ID: notebookId,
    SOURCE_NAME: filename,
    SOURCE_ID: sourceId,
  });

  const resp = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://notebooklm.google.com",
      "Referer": "https://notebooklm.google.com/",
      "x-goog-authuser": String(_currentAuthUser),
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(fileSize),
      "x-goog-upload-protocol": "resumable",
    },
    body,
  });

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => "");
    throw new Error(`Upload session HTTP ${resp.status}: ${errorBody.slice(0, 200)}`);
  }

  const uploadUrl = resp.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Upload session: header x-goog-upload-url absent");
  return uploadUrl;
}

/**
 * Upload un texte sélectionné comme fichier .txt dans un notebook.
 * @param {string} notebookId
 * @param {string} text - Le texte sélectionné
 * @param {string} filename - Nom du fichier .txt
 */
export async function addSourceText(notebookId, text, filename) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(text).buffer;
  const sourceId = await registerFileSource(notebookId, filename);
  const uploadUrl = await startResumableUpload(notebookId, filename, sourceId, buffer.byteLength);
  await uploadFileBytes(uploadUrl, buffer);
}

/**
 * Étape 3 : envoie les bytes du fichier vers l'URL d'upload résumable.
 */
async function uploadFileBytes(uploadUrl, buffer) {
  const resp = await fetch(uploadUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/octet-stream",
      "Origin": "https://notebooklm.google.com",
      "Referer": "https://notebooklm.google.com/",
      "x-goog-authuser": String(_currentAuthUser),
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    },
    body: buffer,
  });

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => "");
    throw new Error(`Upload bytes HTTP ${resp.status}: ${errorBody.slice(0, 200)}`);
  }
}
