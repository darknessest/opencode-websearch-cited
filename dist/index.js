// index.ts
import { tool } from "@opencode-ai/plugin";

// src/anthropic.ts
var ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";
var ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
var ANTHROPIC_MAX_TOKENS = 4096;
var ANTHROPIC_MAX_SEARCH_USES = 5;
var CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
var WEB_SEARCH_SYSTEM_PROMPT = "You are an AI assistant answering a single web search query for the user.";
function buildWebSearchUserPrompt(query) {
  const normalized = query.trim();
  return `perform web search on "${normalized}". Answer concisely from the web search results, and do not append your own sources list.`;
}
function buildHeaders(auth) {
  if (auth.type === "oauth") {
    const access = auth.access.trim();
    if (!access) {
      throw new Error("Missing Anthropic OAuth access token");
    }
    return {
      Authorization: `Bearer ${access}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "Content-Type": "application/json"
    };
  }
  if (auth.type === "api") {
    const key = auth.key.trim();
    if (!key) {
      throw new Error("Missing Anthropic API key");
    }
    return {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json"
    };
  }
  throw new Error("Unsupported auth type for Anthropic web search");
}
function buildSystemBlocks(auth) {
  const searchBlock = { type: "text", text: WEB_SEARCH_SYSTEM_PROMPT };
  if (auth.type !== "oauth") {
    return [searchBlock];
  }
  return [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }, searchBlock];
}
function extractSearchError(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return;
  }
  const block = content;
  if (block.type !== "web_search_tool_result_error") {
    return;
  }
  const errorCode = typeof block.error_code === "string" ? block.error_code.trim() : "";
  return errorCode === "" ? "unknown" : errorCode;
}
function withCitationMarker(text, marker) {
  if (!marker) {
    return text;
  }
  const trimmed = text.trimEnd();
  return `${trimmed}${marker}${text.slice(trimmed.length)}`;
}
function buildCitationMarker(citations, sources, indexByUrl) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return "";
  }
  const indices = [];
  for (const citation of citations) {
    if (citation.type !== "web_search_result_location") {
      continue;
    }
    const url = typeof citation.url === "string" ? citation.url.trim() : "";
    if (!url) {
      continue;
    }
    let index = indexByUrl.get(url);
    if (index === undefined) {
      const title = typeof citation.title === "string" && citation.title.trim() !== "" ? citation.title.trim() : url;
      sources.push({ url, title });
      index = sources.length;
      indexByUrl.set(url, index);
    }
    if (!indices.includes(index)) {
      indices.push(index);
    }
  }
  return indices.sort((a, b) => a - b).map((index) => `[${index}]`).join("");
}
function formatAnthropicWebSearchResponse(response, query) {
  const blocks = response.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return `Web search completed for "${query}", but no results were returned.`;
  }
  const searchResultIndex = blocks.findIndex((block) => block.type === "web_search_tool_result");
  const sources = [];
  const indexByUrl = new Map;
  let searchError;
  let combined = "";
  for (const [position, block] of blocks.entries()) {
    if (block.type === "web_search_tool_result") {
      searchError ??= extractSearchError(block.content);
      continue;
    }
    if (block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const isPreSearchNarration = searchResultIndex >= 0 && position < searchResultIndex;
    if (isPreSearchNarration) {
      continue;
    }
    combined += withCitationMarker(block.text, buildCitationMarker(block.citations, sources, indexByUrl));
  }
  if (!combined.trim()) {
    if (searchError) {
      throw new Error(`Anthropic web search failed: ${searchError}`);
    }
    return `Web search completed for "${query}", but no results were returned.`;
  }
  if (response.stop_reason === "max_tokens" || response.stop_reason === "pause_turn") {
    combined += `

(Response truncated: stop_reason=${response.stop_reason})`;
  }
  if (sources.length === 0) {
    return combined;
  }
  const sourceLines = sources.map((source, index) => `[${index + 1}] ${source.title} (${source.url})`);
  return `${combined}

Sources:
${sourceLines.join(`
`)}`;
}
async function runAnthropicWebSearch(options) {
  const normalizedModel = options.model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid Anthropic web search model");
  }
  const normalizedQuery = options.query.trim();
  if (!normalizedQuery) {
    throw new Error("Query must not be empty");
  }
  const body = {
    model: normalizedModel,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: buildSystemBlocks(options.auth),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildWebSearchUserPrompt(normalizedQuery) }]
      }
    ],
    tools: [
      {
        type: "web_search_20260318",
        name: "web_search",
        max_uses: ANTHROPIC_MAX_SEARCH_USES,
        allowed_callers: ["direct"]
      }
    ]
  };
  const response = await fetch(ANTHROPIC_MESSAGES_ENDPOINT, {
    method: "POST",
    headers: buildHeaders(options.auth),
    body: JSON.stringify(body),
    signal: options.abortSignal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const details = text.trim() !== "" ? ` | responseBody=${text}` : "";
    throw new Error(`status=${response.status} | url=${ANTHROPIC_MESSAGES_ENDPOINT} | requestBody=${JSON.stringify(body)}${details}`);
  }
  const payload = await response.json();
  return formatAnthropicWebSearchResponse(payload, normalizedQuery);
}
function createAnthropicWebsearchClient(model) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid Anthropic web search model");
  }
  return {
    async search(query, abortSignal, getAuth) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new Error("Query must not be empty");
      }
      const auth = await getAuth();
      if (!auth) {
        throw new Error('Missing auth for provider "anthropic"');
      }
      return runAnthropicWebSearch({
        model: normalizedModel,
        query: normalizedQuery,
        abortSignal,
        auth
      });
    }
  };
}

// src/google.ts
var GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
var ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
var ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
var ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
var GEMINI_CODE_ASSIST_GENERATE_PATH = "/v1internal:generateContent";
var GEMINI_CODE_ASSIST_LOAD_PATH = "/v1internal:loadCodeAssist";
var CODE_ASSIST_GENERATE_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD
];
var CODE_ASSIST_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH
];
var ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
var OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
var ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
var ANTIGRAVITY_CLIENT_SECRET = "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";
var REFRESH_BUFFER_MS = 60000;
var CODE_ASSIST_HEADERS = {
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
};
var tokenCache = new Map;
var projectCache = new Map;
function buildGeminiUrl(model) {
  const encoded = encodeURIComponent(model);
  return `${GEMINI_API_BASE}/models/${encoded}:generateContent`;
}
async function runGeminiWebSearch(options) {
  const response = await fetch(buildGeminiUrl(options.model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey,
      "User-Agent": CODE_ASSIST_HEADERS["User-Agent"],
      "X-Goog-Api-Client": CODE_ASSIST_HEADERS["X-Goog-Api-Client"],
      "Client-Metadata": CODE_ASSIST_HEADERS["Client-Metadata"]
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: options.query }]
        }
      ],
      tools: [{ googleSearch: {} }]
    }),
    signal: options.abortSignal
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message ?? `Request failed with status ${response.status}`);
  }
  return await response.json();
}
function formatWebSearchResponse(response, query) {
  const responseText = extractResponseText(response);
  if (!responseText || !responseText.trim()) {
    return `No search results or information found for query: "${query}"`;
  }
  const metadata = extractGroundingMetadata(response);
  const sources = metadata?.groundingChunks;
  const hasSources = Boolean(sources && sources.length > 0);
  let modifiedText = responseText;
  if (hasSources && metadata) {
    const insertions = buildCitationInsertions(metadata);
    if (insertions.length > 0) {
      modifiedText = insertMarkersByUtf8Index(modifiedText, insertions);
    }
  }
  if (hasSources && sources) {
    const sourceLines = sources.map((source, index) => {
      const title = source.web?.title || "Untitled";
      const uri = source.web?.uri || "No URI";
      return `[${index + 1}] ${title} (${uri})`;
    });
    modifiedText += `

Sources:
${sourceLines.join(`
`)}`;
  }
  return modifiedText;
}
function extractResponseText(response) {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    return;
  }
  let combined = "";
  for (const part of parts) {
    if (part.thought) {
      continue;
    }
    if (typeof part.text === "string") {
      combined += part.text;
    }
  }
  return combined || undefined;
}
function extractGroundingMetadata(response) {
  return response.candidates?.[0]?.groundingMetadata;
}
function buildCitationInsertions(metadata) {
  const supports = metadata?.groundingSupports;
  if (!supports || supports.length === 0) {
    return [];
  }
  const insertions = [];
  for (const support of supports) {
    const segment = support.segment;
    const indices = support.groundingChunkIndices;
    if (!segment || segment.endIndex == null || !indices || indices.length === 0) {
      continue;
    }
    const uniqueSorted = Array.from(new Set(indices)).sort((a, b) => a - b);
    const marker = uniqueSorted.map((idx) => `[${idx + 1}]`).join("");
    insertions.push({
      index: segment.endIndex,
      marker
    });
  }
  insertions.sort((a, b) => b.index - a.index);
  return insertions;
}
function insertMarkersByUtf8Index(text, insertions) {
  if (insertions.length === 0) {
    return text;
  }
  const encoder = new TextEncoder;
  const responseBytes = encoder.encode(text);
  const parts = [];
  let lastIndex = responseBytes.length;
  for (const insertion of insertions) {
    const position = Math.min(insertion.index, lastIndex);
    parts.unshift(responseBytes.subarray(position, lastIndex));
    parts.unshift(encoder.encode(insertion.marker));
    lastIndex = position;
  }
  parts.unshift(responseBytes.subarray(0, lastIndex));
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const finalBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    finalBytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(finalBytes);
}

class GeminiApiKeyClient {
  apiKey;
  model;
  constructor(apiKey, model) {
    const normalizedKey = apiKey.trim();
    const normalizedModel = model.trim();
    if (!normalizedKey || !normalizedModel) {
      throw new Error("Invalid Google API configuration");
    }
    this.apiKey = normalizedKey;
    this.model = normalizedModel;
  }
  async search(query, abortSignal) {
    const normalizedQuery = query.trim();
    const response = await runGeminiWebSearch({
      apiKey: this.apiKey,
      model: this.model,
      query: normalizedQuery,
      abortSignal
    });
    return formatWebSearchResponse(response, normalizedQuery);
  }
}
function parseRefresh(refresh) {
  const normalized = refresh.trim();
  if (!normalized) {
    return { refreshToken: "" };
  }
  const [token, project, managed] = normalized.split("|");
  const refreshToken = token?.trim() ?? "";
  const projectId = project?.trim() ?? "";
  const managedProjectId = managed?.trim() ?? "";
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined
  };
}
function getCachedAccess(refreshToken) {
  const cached = tokenCache.get(refreshToken);
  if (!cached) {
    return;
  }
  if (cached.expiresAt <= Date.now() + REFRESH_BUFFER_MS) {
    tokenCache.delete(refreshToken);
    return;
  }
  return cached;
}
function cacheToken(refreshToken, accessToken, expiresAt) {
  if (!refreshToken || !accessToken) {
    return;
  }
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    tokenCache.set(refreshToken, { accessToken, expiresAt });
  }
}
async function requestToken(refreshToken) {
  const requestTime = Date.now();
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET
    })
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message ?? `Request failed with status ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("Token refresh response missing access_token");
  }
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const expiresAt = expiresIn > 0 ? requestTime + expiresIn * 1000 : requestTime;
  return {
    accessToken: payload.access_token,
    expiresAt
  };
}
async function refreshAccessToken(refreshToken) {
  const result = await requestToken(refreshToken);
  cacheToken(refreshToken, result.accessToken, result.expiresAt);
  return result;
}
function buildMetadata(projectId) {
  const metadata = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI"
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }
  return metadata;
}
async function loadManagedProject(accessToken, projectId, abortSignal) {
  const loadHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": CODE_ASSIST_HEADERS["Client-Metadata"]
  };
  const requestBody = {
    metadata: buildMetadata(projectId)
  };
  const loadEndpoints = Array.from(new Set([...CODE_ASSIST_LOAD_ENDPOINTS, ...CODE_ASSIST_GENERATE_ENDPOINTS]));
  for (const baseEndpoint of loadEndpoints) {
    try {
      const response = await fetch(`${baseEndpoint}${GEMINI_CODE_ASSIST_LOAD_PATH}`, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify(requestBody),
        signal: abortSignal
      });
      if (!response.ok) {
        continue;
      }
      return await response.json();
    } catch {}
  }
  return null;
}
function extractManagedProjectId(payload) {
  if (!payload) {
    return;
  }
  const project = payload.cloudaicompanionProject;
  if (typeof project === "string" && project.trim() !== "") {
    return project;
  }
  if (project && typeof project === "object" && project.id) {
    const id = project.id;
    if (typeof id === "string" && id.trim() !== "") {
      return id;
    }
  }
  return;
}
async function resolveProjectId(accessToken, refreshToken, refreshParts, abortSignal) {
  if (refreshParts.managedProjectId) {
    return refreshParts.managedProjectId;
  }
  const cached = projectCache.get(refreshToken);
  if (cached) {
    return cached;
  }
  const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
  const desiredProjectId = refreshParts.projectId ?? fallbackProjectId;
  const loadPayload = await loadManagedProject(accessToken, desiredProjectId, abortSignal);
  const resolvedManagedProjectId = extractManagedProjectId(loadPayload);
  if (resolvedManagedProjectId) {
    projectCache.set(refreshToken, resolvedManagedProjectId);
    return resolvedManagedProjectId;
  }
  if (refreshParts.projectId) {
    return refreshParts.projectId;
  }
  return fallbackProjectId;
}
function parseExpires(expires) {
  if (typeof expires === "number" && Number.isFinite(expires)) {
    return expires;
  }
  return;
}
function accessTokenExpired(accessToken, expiresAt) {
  if (!accessToken || typeof expiresAt !== "number") {
    return true;
  }
  return expiresAt <= Date.now() + REFRESH_BUFFER_MS;
}
async function requestGenerateContent(accessToken, projectId, model, query, abortSignal) {
  const requestPayload = {
    contents: [
      {
        role: "user",
        parts: [{ text: query }]
      }
    ],
    tools: [{ googleSearch: {} }]
  };
  const body = JSON.stringify({
    project: projectId,
    model,
    request: requestPayload,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": CODE_ASSIST_HEADERS["User-Agent"],
    "X-Goog-Api-Client": CODE_ASSIST_HEADERS["X-Goog-Api-Client"],
    "Client-Metadata": CODE_ASSIST_HEADERS["Client-Metadata"]
  };
  let lastError;
  for (const baseUrl of CODE_ASSIST_GENERATE_ENDPOINTS) {
    const response = await fetch(`${baseUrl}${GEMINI_CODE_ASSIST_GENERATE_PATH}`, {
      method: "POST",
      headers,
      body,
      signal: abortSignal
    });
    if (!response.ok) {
      const message = await readErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, message };
      }
      lastError = { status: response.status, message };
      continue;
    }
    const text = await response.text();
    if (!text) {
      throw new Error("Empty response from Google Code Assist");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON response from Google Code Assist");
    }
    const effectiveResponse = extractGenerateContentResponse(parsed);
    if (!effectiveResponse) {
      throw new Error("Google Code Assist response did not include a valid response payload");
    }
    return { ok: true, body: effectiveResponse };
  }
  if (lastError) {
    return { ok: false, status: lastError.status, message: lastError.message };
  }
  return {
    ok: false,
    status: 502,
    message: "Request failed for all Google Code Assist endpoints."
  };
}
function createGeminiOAuthWebSearchClient(authDetails, model) {
  const refreshParts = parseRefresh(authDetails.refresh ?? "");
  const refreshToken = refreshParts.refreshToken;
  if (!refreshToken) {
    throw new Error("Missing Google OAuth refresh token");
  }
  const initialAccess = authDetails.access?.trim() ?? "";
  const initialExpires = parseExpires(authDetails.expires);
  return {
    async search(query, abortSignal) {
      const normalizedQuery = query.trim();
      const cached = getCachedAccess(refreshToken);
      let accessToken = cached?.accessToken ?? initialAccess;
      let expiresAt = cached?.expiresAt ?? initialExpires;
      let refreshedThisRequest = false;
      if (accessTokenExpired(accessToken, expiresAt)) {
        const refreshed2 = await refreshAccessToken(refreshToken);
        accessToken = refreshed2.accessToken;
        expiresAt = refreshed2.expiresAt;
        refreshedThisRequest = true;
      }
      if (!accessToken) {
        throw new Error("Missing Google OAuth access token");
      }
      if (typeof expiresAt === "number") {
        cacheToken(refreshToken, accessToken, expiresAt);
      }
      const effectiveProjectId = await resolveProjectId(accessToken, refreshToken, refreshParts, abortSignal);
      const firstAttempt = await requestGenerateContent(accessToken, effectiveProjectId, model, normalizedQuery, abortSignal);
      if (firstAttempt.ok) {
        return formatWebSearchResponse(firstAttempt.body, normalizedQuery);
      }
      const shouldRetry = (firstAttempt.status === 401 || firstAttempt.status === 403) && !refreshedThisRequest;
      if (!shouldRetry) {
        throw new Error(firstAttempt.message ?? `Request failed with status ${firstAttempt.status}`);
      }
      tokenCache.delete(refreshToken);
      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      expiresAt = refreshed.expiresAt;
      refreshedThisRequest = true;
      cacheToken(refreshToken, accessToken, expiresAt);
      const retry = await requestGenerateContent(accessToken, effectiveProjectId, model, normalizedQuery, abortSignal);
      if (retry.ok) {
        return formatWebSearchResponse(retry.body, normalizedQuery);
      }
      throw new Error(retry.message ?? `Request failed with status ${retry.status}`);
    }
  };
}
function extractGenerateContentResponse(payload) {
  const candidateObject = (() => {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === "object") {
          return item;
        }
      }
      return;
    }
    if (payload && typeof payload === "object") {
      return payload;
    }
    return;
  })();
  if (!candidateObject) {
    return;
  }
  const withResponse = candidateObject;
  if (withResponse.response && typeof withResponse.response === "object") {
    return withResponse.response;
  }
  if (withResponse.candidates) {
    return candidateObject;
  }
  return;
}
async function readErrorMessage(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return;
  }
}
function createGeminiWebSearchClient(config) {
  return new GeminiApiKeyClient(config.apiKey, config.model);
}
function createWebSearchClientForGoogle(authDetails, model) {
  if (authDetails.type === "api") {
    const apiKey = extractApiKey(authDetails);
    if (!apiKey) {
      throw new Error("Missing Google API key");
    }
    return createGeminiWebSearchClient({
      mode: "api",
      apiKey,
      model
    });
  }
  if (authDetails.type === "oauth") {
    const oauthAuth = authDetails;
    return createGeminiOAuthWebSearchClient(oauthAuth, model);
  }
  throw new Error("Unsupported auth type for Google web search");
}
function extractApiKey(authDetails) {
  if (!authDetails || authDetails.type !== "api") {
    return;
  }
  const normalized = authDetails.key.trim();
  return normalized === "" ? undefined : normalized;
}
function createGoogleWebsearchClient(model) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid Google web search model");
  }
  return {
    async search(query, abortSignal, getAuth) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new Error("Query must not be empty");
      }
      const auth = await getAuth();
      if (!auth) {
        throw new Error('Missing auth for provider "google"');
      }
      const client = createWebSearchClientForGoogle(auth, normalizedModel);
      return client.search(normalizedQuery, abortSignal);
    }
  };
}

// src/codex_prompt.txt
var codex_prompt_default = `You are OpenCode, the best coding agent on the planet.

You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

## Editing constraints
- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.
- Only add comments if they are necessary to make a non-obvious block easier to understand.
- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).

## Tool usage
- Prefer specialized tools over shell for file operations:
  - Use Read to view files, Edit to modify files, and Write only when needed.
  - Use Glob to find files by name and Grep to search file contents.
- Use Bash for terminal operations (git, bun, builds, tests, running scripts).
- Run tool calls in parallel when neither call needs the other’s output; otherwise run sequentially.

## Git and workspace hygiene
- You may be in a dirty git worktree.
    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.
    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.
    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.
    * If the changes are in unrelated files, just ignore them and don't revert them.
- Do not amend commits unless explicitly requested.
- **NEVER** use destructive commands like \`git reset --hard\` or \`git checkout --\` unless specifically requested or approved by the user.

## Frontend tasks
When doing frontend design tasks, avoid collapsing into bland, generic layouts.
Aim for interfaces that feel intentional and deliberate.
- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).
- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.
- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.
- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.
- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.
- Ensure the page loads properly on both desktop and mobile.

Exception: If working within an existing website or design system, preserve the established patterns, structure, and visual language.

## Presenting your work and final message

You are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.

- Default: be very concise; friendly coding teammate tone.
- Default: do the work without asking questions. Treat short tasks as sufficient direction; infer missing details by reading the codebase and following existing conventions.
- Questions: only ask when you are truly blocked after checking relevant context AND you cannot safely pick a reasonable default. This usually means one of:
  * The request is ambiguous in a way that materially changes the result and you cannot disambiguate by reading the repo.
  * The action is destructive/irreversible, touches production, or changes billing/security posture.
  * You need a secret/credential/value that cannot be inferred (API key, account id, etc.).
- If you must ask: do all non-blocked work first, then ask exactly one targeted question, include your recommended default, and state what would change based on the answer.
- Never ask permission questions like "Should I proceed?" or "Do you want me to run tests?"; proceed with the most reasonable option and mention what you did.
- For substantial work, summarize clearly; follow final‑answer formatting.
- Skip heavy formatting for simple confirmations.
- Don't dump large files you've written; reference paths only.
- No "save/copy this file" - User is on the same machine.
- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.
- For code changes:
  * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with "summary", just jump right in.
  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.
  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.
- The user does not command execution outputs. When asked to show the output of a command (e.g. \`git show\`), relay the important details in your answer or summarize the key lines so the user understands the result.

## Final answer structure and style guidelines

- Plain text; CLI handles styling. Use structure only when it helps scannability.
- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.
- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.
- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.
- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.
- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.
- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no "above/below"; parallel wording.
- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.
- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.
- File References: When referencing files in your response follow the below rules:
  * Use inline code to make file paths clickable.
  * Each reference should have a stand alone path. Even if it's the same file.
  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.
  * Optionally include line/column (1‑based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).
  * Do not use URIs like file://, vscode://, or https://.
  * Do not provide range of lines
  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5
`;

// src/openai.ts
function buildWebSearchUserPrompt2(query) {
  const normalized = query.trim();
  return `perform web search on "${normalized}". Return results with inline citations (**only** source index like [1], no URL in the answer) and end with a Sources list of URLs.`;
}
function getAccessToken(auth) {
  if (auth.type === "oauth") {
    const access = auth.access.trim();
    if (!access) {
      throw new Error("Missing OpenAI OAuth access token");
    }
    return access;
  }
  if (auth.type === "api") {
    const key = auth.key.trim();
    if (!key) {
      throw new Error("Missing OpenAI API key");
    }
    return key;
  }
  const token = auth.token.trim();
  if (!token) {
    throw new Error("Missing OpenAI token");
  }
  return token;
}
function extractChatGPTAccountId(auth) {
  if (auth.type !== "oauth") {
    return;
  }
  const access = auth.access.trim();
  if (!access) {
    return;
  }
  const parts = access.split(".");
  if (parts.length !== 3) {
    return;
  }
  try {
    const payload = parts[1];
    if (!payload) {
      return;
    }
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const root = parsed;
    const claim = root["https://api.openai.com/auth"];
    if (!claim || typeof claim !== "object") {
      return;
    }
    const accountId = claim.chatgpt_account_id;
    if (typeof accountId !== "string") {
      return;
    }
    const trimmed = accountId.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return;
  }
}
async function runOpenAIWebSearch(options) {
  const normalizedModel = options.model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid OpenAI web search model");
  }
  const normalizedQuery = options.query.trim();
  if (!normalizedQuery) {
    throw new Error("Query must not be empty");
  }
  const accessToken = getAccessToken(options.auth);
  const isOAuth = options.auth.type === "oauth";
  const body = {
    model: normalizedModel,
    instructions: "",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildWebSearchUserPrompt2(normalizedQuery)
          }
        ]
      }
    ],
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"]
  };
  if (options.reasoningEffort || options.reasoningSummary) {
    body.reasoning = {
      effort: options.reasoningEffort,
      summary: options.reasoningSummary
    };
  }
  body.store = false;
  if (options.textVerbosity) {
    body.text = {
      verbosity: options.textVerbosity
    };
  }
  if (Array.isArray(options.include) && options.include.length > 0) {
    const filtered = options.include.filter((value) => typeof value === "string" && value.trim() !== "");
    if (filtered.length > 0) {
      body.include = filtered;
    }
  }
  body.stream = true;
  body.tool_choice = "auto";
  body.parallel_tool_calls = true;
  if (isOAuth) {
    body.instructions = codex_prompt_default;
  } else {
    body.instructions = "You are an AI assistant answering a single web search query for the user.";
  }
  const url = isOAuth ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.openai.com/v1/responses";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental"
  };
  if (isOAuth) {
    const accountId = extractChatGPTAccountId(options.auth);
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }
    headers.originator = "codex_cli_rs";
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.abortSignal
  });
  if (!response.ok) {
    const message = await buildErrorDetails(response, url, body);
    throw new Error(message);
  }
  const payload = await readOpenAIResponsePayload(response);
  const text = extractOpenAIText(payload);
  if (!text || !text.trim()) {
    return `Web search completed for "${normalizedQuery}", but no results were returned.`;
  }
  return text;
}
function createOpenAIWebsearchClient(model, config) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid OpenAI web search model");
  }
  return {
    async search(query, abortSignal, getAuth) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new Error("Query must not be empty");
      }
      const auth = await getAuth();
      if (!auth) {
        throw new Error('Missing auth for provider "openai"');
      }
      return runOpenAIWebSearch({
        model: normalizedModel,
        query: normalizedQuery,
        abortSignal,
        auth,
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        textVerbosity: config.textVerbosity,
        store: config.store,
        include: config.include
      });
    }
  };
}
function extractOpenAIText(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const root = payload;
  const output = root.output;
  if (!Array.isArray(output) || output.length === 0) {
    return;
  }
  let combined = "";
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const kind = part.type;
      if (kind !== "output_text") {
        continue;
      }
      const textField = part.text;
      if (typeof textField === "string") {
        combined += textField;
      } else if (textField && typeof textField === "object") {
        const obj = textField;
        if (typeof obj.value === "string") {
          combined += obj.value;
        }
      }
    }
  }
  return combined || undefined;
}
async function buildErrorDetails(response, url, body) {
  const parts = [];
  parts.push(`status=${response.status}`);
  parts.push(`url=${url}`);
  const safeBody = { ...body };
  if (typeof safeBody.instructions === "string") {
    const value = safeBody.instructions;
    const maxLength = 512;
    if (value.length > maxLength) {
      const headLength = 256;
      const tailLength = 128;
      const head = value.slice(0, headLength);
      const tail = value.slice(-tailLength);
      const omitted = value.length - headLength - tailLength;
      safeBody.instructions = `${head} ... [${omitted} chars truncated] ... ${tail}`;
    }
  }
  parts.push(`requestBody=${JSON.stringify(safeBody)}`);
  let rawText;
  try {
    rawText = await response.text();
  } catch {}
  if (rawText) {
    let parsedMessage;
    try {
      const parsed = JSON.parse(rawText);
      const message = parsed.error?.message;
      if (typeof message === "string" && message.trim() !== "") {
        parsedMessage = message.trim();
      }
    } catch {}
    if (parsedMessage) {
      parts.unshift(`error=${parsedMessage}`);
    }
    parts.push(`responseBody=${rawText}`);
  }
  return parts.join(" | ");
}
function parseOpenAISseEvent(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return;
  }
}
async function readOpenAIResponsePayload(response) {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed === "") {
    return {};
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed;
    } catch {}
  }
  const extracted = extractOpenAIResponseFromSse(text);
  if (extracted !== undefined) {
    return extracted;
  }
  throw new Error("Failed to parse JSON");
}
function extractOpenAIResponseFromSse(sseText) {
  const lines = sseText.split(`
`);
  const streamedItems = [];
  for (const line of lines) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    const parsed = parseOpenAISseEvent(payload);
    if (!parsed) {
      continue;
    }
    const kind = parsed.type ?? "";
    if (kind === "response.failed" || kind === "error") {
      throw new Error(`OpenAI stream failed | event=${payload}`);
    }
    if (kind === "response.output_item.done") {
      if (parsed.item && typeof parsed.item === "object") {
        streamedItems.push(parsed.item);
      }
      continue;
    }
    if (kind === "response.done" || kind === "response.completed") {
      const response = parsed.response;
      if (!response) {
        continue;
      }
      const output = response.output;
      if (Array.isArray(output) && output.length > 0) {
        return response;
      }
      return { ...response, output: streamedItems };
    }
  }
  return streamedItems.length > 0 ? { output: streamedItems } : undefined;
}

// src/openrouter.ts
var OPENROUTER_RESPONSES_ENDPOINT = "https://openrouter.ai/api/v1/responses";
function buildWebSearchUserPrompt3(query) {
  const normalized = query.trim();
  return `perform web search on "${normalized}". Return results with inline citations (**only** source index like [1], no URL in the answer) and end with a Sources list of URLs.`;
}
function getApiKey(auth) {
  if (auth.type !== "api") {
    throw new Error("OpenRouter only supports API key authentication");
  }
  const key = auth.key.trim();
  if (!key) {
    throw new Error("Missing OpenRouter API key");
  }
  return key;
}
function extractOutputText(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const root = payload;
  const direct = root.output_text;
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct;
  }
  const output = root.output;
  if (!Array.isArray(output) || output.length === 0) {
    return;
  }
  let combined = "";
  for (const item of output) {
    if (item.type !== "message") {
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part.type !== "output_text") {
        continue;
      }
      const text = part.text;
      if (typeof text === "string") {
        combined += text;
      }
    }
  }
  return combined || undefined;
}
async function runOpenRouterWebSearch(options) {
  const normalizedModel = options.model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid OpenRouter web search model");
  }
  const normalizedQuery = options.query.trim();
  if (!normalizedQuery) {
    throw new Error("Query must not be empty");
  }
  const apiKey = getApiKey(options.auth);
  const body = {
    model: normalizedModel,
    input: buildWebSearchUserPrompt3(normalizedQuery),
    plugins: [
      {
        id: "web",
        search_prompt: buildWebSearchUserPrompt3(normalizedQuery)
      }
    ],
    store: false,
    stream: false
  };
  const response = await fetch(OPENROUTER_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: options.abortSignal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const details = text.trim() !== "" ? ` | responseBody=${text}` : "";
    throw new Error(`status=${response.status} | url=${OPENROUTER_RESPONSES_ENDPOINT} | requestBody=${JSON.stringify(body)}${details}`);
  }
  const payload = await response.json();
  const outputText = extractOutputText(payload);
  if (!outputText || !outputText.trim()) {
    return `Web search completed for "${normalizedQuery}", but no results were returned.`;
  }
  return outputText;
}
function createOpenRouterWebsearchClient(model) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("Invalid OpenRouter web search model");
  }
  return {
    async search(query, abortSignal, getAuth) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new Error("Query must not be empty");
      }
      const auth = await getAuth();
      if (!auth) {
        throw new Error('Missing auth for provider "openrouter"');
      }
      return runOpenRouterWebSearch({
        model: normalizedModel,
        query: normalizedQuery,
        abortSignal,
        auth
      });
    }
  };
}

// index.ts
var ANTHROPIC_PROVIDER_ID = "anthropic";
var GOOGLE_PROVIDER_ID = "google";
var OPENAI_PROVIDER_ID = "openai";
var OPENROUTER_PROVIDER_ID = "openrouter";
var CITED_SEARCH_TOOL_DESCRIPTION = "Performs a Gemini-style grounded web search: returns a concise digest with inline citations and a Sources list of URLs. NOTE: for LLM rate limits, DO NOT parallel this tool > 5";
var WEBSEARCH_ARGS = {
  query: tool.schema.string().describe("The natural language web search query.")
};
var WEBSEARCH_ALLOWED_KEYS = new Set(Object.keys(WEBSEARCH_ARGS));
var WEBSEARCH_ALLOWED_KEYS_DESCRIPTION = Array.from(WEBSEARCH_ALLOWED_KEYS).map((key) => `'${key}'`).join(", ");
var SUPPORTED_PROVIDER_IDS = new Set([
  ANTHROPIC_PROVIDER_ID,
  GOOGLE_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID
]);
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
var authRegistry = new Map;
function registerGetAuth(providerID, getAuth) {
  authRegistry.set(providerID, getAuth);
}
function resolveGetAuth(providerID) {
  return authRegistry.get(providerID);
}
function findWebsearchCitedConfigs(config) {
  const providers = config.provider;
  if (!providers || typeof providers !== "object") {
    return { selections: [] };
  }
  const selections = [];
  let firstError;
  for (const [providerID, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || typeof providerConfig !== "object") {
      continue;
    }
    const options = providerConfig.options;
    if (!isRecord(options)) {
      continue;
    }
    if (!("websearch_cited" in options)) {
      continue;
    }
    const cited = options.websearch_cited;
    if (!isRecord(cited)) {
      firstError ??= `Invalid websearch_cited configuration for provider "${providerID}".`;
      continue;
    }
    const candidate = cited.model;
    if (typeof candidate !== "string" || candidate.trim() === "") {
      firstError ??= `Missing websearch_cited model for provider "${providerID}".`;
      continue;
    }
    if (!SUPPORTED_PROVIDER_IDS.has(providerID)) {
      firstError ??= `Unsupported provider "${providerID}" for websearch_cited.`;
      continue;
    }
    selections.push({
      providerID,
      model: candidate.trim()
    });
  }
  if (selections.length === 0 && firstError) {
    return { selections, error: firstError };
  }
  return { selections };
}
async function resolveCallerProviderID(client, sessionID, messageID) {
  if (!client) {
    return;
  }
  const { data } = await client.session.message({ path: { id: sessionID, messageID } });
  if (!data || data.info.role !== "assistant") {
    return;
  }
  return data.info.providerID;
}
function parseOpenAIOptions(providerConfig, model) {
  if (!isRecord(providerConfig)) {
    return {};
  }
  const providerRecord = providerConfig;
  const rawOptions = providerRecord.options;
  const baseOptions = isRecord(rawOptions) ? rawOptions : undefined;
  let modelOptions;
  const rawModels = providerRecord.models;
  if (model && isRecord(rawModels)) {
    const modelsRecord = rawModels;
    const entry = modelsRecord[model];
    if (isRecord(entry)) {
      const entryOptions = entry.options;
      if (isRecord(entryOptions)) {
        modelOptions = entryOptions;
      }
    }
  }
  const merged = {
    ...baseOptions ?? {},
    ...modelOptions ?? {}
  };
  const result = {};
  const reasoningEffort = merged.reasoningEffort;
  if (typeof reasoningEffort === "string" && reasoningEffort.trim() !== "") {
    result.reasoningEffort = reasoningEffort.trim();
  }
  const reasoningSummary = merged.reasoningSummary;
  if (typeof reasoningSummary === "string" && reasoningSummary.trim() !== "") {
    result.reasoningSummary = reasoningSummary.trim();
  }
  const textVerbosity = merged.textVerbosity;
  if (typeof textVerbosity === "string" && textVerbosity.trim() !== "") {
    result.textVerbosity = textVerbosity.trim();
  }
  const store = merged.store;
  if (typeof store === "boolean") {
    result.store = store;
  }
  const include = merged.include;
  if (Array.isArray(include)) {
    const filtered = include.filter((value) => typeof value === "string" && value.trim() !== "");
    if (filtered.length > 0) {
      result.include = filtered;
    }
  }
  return result;
}
var WebsearchCitedPlugin = ({ client: sdkClient }) => {
  let selections = [];
  let openaiConfig = {};
  let configError;
  return Promise.resolve({
    auth: {
      provider: OPENROUTER_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(OPENROUTER_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: "api",
          label: "OpenRouter API key"
        }
      ]
    },
    config: (config) => {
      const { selections: found, error } = findWebsearchCitedConfigs(config);
      selections = found;
      openaiConfig = {};
      configError = error;
      const openaiSelection = found.find((entry) => entry.providerID === OPENAI_PROVIDER_ID);
      if (openaiSelection) {
        openaiConfig = parseOpenAIOptions(config.provider?.openai, openaiSelection.model);
      }
      return Promise.resolve();
    },
    tool: {
      websearch_cited: tool({
        description: CITED_SEARCH_TOOL_DESCRIPTION,
        args: WEBSEARCH_ARGS,
        async execute(args, context) {
          const argKeys = Object.keys(args ?? {});
          const extraKeys = argKeys.filter((key) => !WEBSEARCH_ALLOWED_KEYS.has(key));
          if (extraKeys.length > 0) {
            throw new Error(`Unknown argument(s): ${extraKeys.join(", ")}, only ${WEBSEARCH_ALLOWED_KEYS_DESCRIPTION} supported.`);
          }
          const query = args.query?.trim();
          if (!query) {
            throw new Error("The 'query' parameter cannot be empty.");
          }
          if (configError) {
            throw new Error(configError);
          }
          const fallback = selections[0];
          if (!fallback) {
            throw new Error("Missing web search model configuration.");
          }
          const callerProviderID = await resolveCallerProviderID(sdkClient, context.sessionID, context.messageID);
          const { providerID: selectedProvider, model: selectedModel } = selections.find((entry) => entry.providerID === callerProviderID) ?? fallback;
          if (selectedProvider === OPENAI_PROVIDER_ID) {
            const getAuth2 = resolveGetAuth(OPENAI_PROVIDER_ID);
            if (!getAuth2) {
              throw new Error('Missing auth for provider "openai". Authenticate via `opencode auth login`.');
            }
            const client2 = createOpenAIWebsearchClient(selectedModel, openaiConfig);
            return client2.search(query, context.abort, getAuth2);
          }
          if (selectedProvider === ANTHROPIC_PROVIDER_ID) {
            const getAuth2 = resolveGetAuth(ANTHROPIC_PROVIDER_ID);
            if (!getAuth2) {
              throw new Error('Missing auth for provider "anthropic". Authenticate via `opencode auth login`.');
            }
            const client2 = createAnthropicWebsearchClient(selectedModel);
            return client2.search(query, context.abort, getAuth2);
          }
          if (selectedProvider === OPENROUTER_PROVIDER_ID) {
            const getAuth2 = resolveGetAuth(OPENROUTER_PROVIDER_ID);
            if (!getAuth2) {
              throw new Error('Missing auth for provider "openrouter". Authenticate via `opencode auth login`.');
            }
            const client2 = createOpenRouterWebsearchClient(selectedModel);
            return client2.search(query, context.abort, getAuth2);
          }
          const getAuth = resolveGetAuth(GOOGLE_PROVIDER_ID);
          if (!getAuth) {
            throw new Error('Missing auth for provider "google". Authenticate via `opencode auth login`.');
          }
          const client = createGoogleWebsearchClient(selectedModel);
          return client.search(query, context.abort, getAuth);
        }
      })
    }
  });
};
var WebsearchCitedGooglePlugin = () => {
  return Promise.resolve({
    auth: {
      provider: GOOGLE_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(GOOGLE_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: "api",
          label: "Google API key"
        }
      ]
    }
  });
};
var WebsearchCitedAnthropicPlugin = () => {
  return Promise.resolve({
    auth: {
      provider: ANTHROPIC_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(ANTHROPIC_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: "api",
          label: "Anthropic API key"
        }
      ]
    }
  });
};
var WebsearchCitedOpenAIPlugin = () => {
  return Promise.resolve({
    auth: {
      provider: OPENAI_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(OPENAI_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: "api",
          label: "OpenAI API key"
        }
      ]
    }
  });
};
var opencode_websearch_cited_default = WebsearchCitedPlugin;
export {
  opencode_websearch_cited_default as default,
  WebsearchCitedOpenAIPlugin,
  WebsearchCitedGooglePlugin,
  WebsearchCitedAnthropicPlugin
};

//# debugId=AA3FD18B8F0C211464756E2164756E21
//# sourceMappingURL=index.js.map
