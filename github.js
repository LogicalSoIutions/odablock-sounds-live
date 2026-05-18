const GITHUB_API_BASE = "https://api.github.com";

function buildContentsUrl(config) {
  const encodedPath = config.filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodedPath}`;
}

function buildAuthHeaders(config) {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": `${config.owner}-${config.repo}-livestream-publisher`,
  };
}

function decodeBase64Json(base64) {
  try {
    const buffer = Buffer.from(base64, "base64");
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function validateConfig(config) {
  const missing = [];
  if (!config.token) missing.push("GITHUB_TOKEN");
  if (!config.owner) missing.push("GITHUB_OWNER");
  if (!config.repo) missing.push("GITHUB_REPO");
  if (!config.filePath) missing.push("GITHUB_FILE_PATH");

  if (missing.length > 0) {
    throw new Error(
      `Missing GitHub configuration: ${missing.join(", ")}. Update your .env.`
    );
  }
}

async function fetchPublishedState(config) {
  validateConfig(config);

  const url = `${buildContentsUrl(config)}?ref=${encodeURIComponent(config.branch)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildAuthHeaders(config),
  });

  if (response.status === 404) {
    return { exists: false, sha: null, parsed: null };
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GET failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const sha = typeof payload?.sha === "string" ? payload.sha : null;
  const encoding = payload?.encoding;
  const content = typeof payload?.content === "string" ? payload.content : "";

  let parsed = null;
  if (encoding === "base64" && content) {
    parsed = decodeBase64Json(content.replace(/\n/g, ""));
  }

  return { exists: true, sha, parsed };
}

async function publishStatus(config, status, currentSha) {
  validateConfig(config);

  const commitMessage = status.live
    ? `Update livestream.json: live - ${status.title ?? ""}`.trim()
    : "Update livestream.json: offline";

  return publishFile(config, config.filePath, status, commitMessage, currentSha);
}

async function publishFile(config, filePath, data, commitMessage, currentSha) {
  validateConfig(config);

  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodedPath}`;

  const fileContent = `${JSON.stringify(data, null, 2)}\n`;
  const base64Content = Buffer.from(fileContent, "utf8").toString("base64");

  const body = {
    message: commitMessage,
    content: base64Content,
    branch: config.branch,
  };

  if (currentSha) {
    body.sha = currentSha;
  }

  if (config.authorName && config.authorEmail) {
    body.committer = { name: config.authorName, email: config.authorEmail };
    body.author = { name: config.authorName, email: config.authorEmail };
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...buildAuthHeaders(config),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub PUT failed (${response.status}): ${errorBody}`);
  }

  const payload = await response.json();
  const newSha = typeof payload?.content?.sha === "string" ? payload.content.sha : null;
  return { sha: newSha };
}

module.exports = {
  fetchPublishedState,
  publishStatus,
  publishFile,
};
