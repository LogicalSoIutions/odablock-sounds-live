const fs = require("fs");
const path = require("path");

const github = require("./github");
const kickWebhook = require("./kick-webhook");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function readStringField(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function findTitleDeep(value, depth) {
  if (!value || typeof value !== "object" || depth < 0) return null;

  const direct = readStringField(value, ["title", "stream_title", "session_title"]);
  if (direct) return direct;
  if (depth === 0) return null;

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const nestedTitle = findTitleDeep(nested, depth - 1);
      if (nestedTitle) return nestedTitle;
    }
  }

  return null;
}

function getTitleFromChannel(channel) {
  if (!channel || typeof channel !== "object") return null;

  const sources = [
    channel.stream,
    channel.livestream,
    channel.live_stream,
    channel.current_livestream,
    channel.recent_livestream,
    channel,
  ];

  for (const source of sources) {
    const title = findTitleDeep(source, 2);
    if (title) return title;
  }

  return null;
}

function formatTitleForJson(title) {
  if (typeof title !== "string") return null;
  return title.replace(/\|/g, "-");
}

function parseWentLiveAt(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) {
    return null;
  }

  return date.toISOString();
}

function parseStreamWentLiveAt(stream) {
  if (!stream?.is_live) return null;
  return parseWentLiveAt(stream.start_time);
}

function isEventForMonitoredChannel(payload, channelSlug) {
  const slug = payload?.broadcaster?.channel_slug;
  if (!slug) return true;
  return slug.toLowerCase() === channelSlug.toLowerCase();
}

function statusFromLivestreamStatusEvent(payload) {
  const isLive = Boolean(payload?.is_live);
  const title = isLive ? formatTitleForJson(payload?.title) : null;
  const wentLiveAt = isLive ? parseWentLiveAt(payload?.started_at) : null;
  return { isLive, title, wentLiveAt };
}

function statusFromLivestreamMetadataEvent(payload) {
  const title = formatTitleForJson(payload?.metadata?.title);
  if (!title) return null;
  return { isLive: true, title, wentLiveAt: null };
}

function toPublishedStatus(status) {
  if (status.isLive) {
    const payload = { live: true, title: status.title ?? null };
    if (status.wentLiveAt) {
      payload.wentLiveAt = status.wentLiveAt;
    }
    return payload;
  }
  return { live: false };
}

function normalizePublishedStatus(input) {
  if (!input || typeof input !== "object") return null;
  if (input.live === true) {
    const normalized = {
      live: true,
      title: typeof input.title === "string" ? input.title : null,
    };
    if (typeof input.wentLiveAt === "string" && input.wentLiveAt.trim()) {
      normalized.wentLiveAt = input.wentLiveAt.trim();
    }
    return normalized;
  }
  if (input.live === false) {
    return { live: false };
  }
  return null;
}

function resolveWentLiveAt(nextStatus, previousPublished) {
  if (!nextStatus.isLive) return null;

  if (nextStatus.wentLiveAt) return nextStatus.wentLiveAt;
  if (previousPublished?.live === true && previousPublished.wentLiveAt) {
    return previousPublished.wentLiveAt;
  }

  return new Date().toISOString();
}

function shouldPublishStatus(previousPublished, nextStatus) {
  if (!previousPublished) return true;

  if (nextStatus.isLive) {
    if (previousPublished.live !== true) return true;
    if (previousPublished.title !== (nextStatus.title ?? null)) return true;
    const nextWentLiveAt = resolveWentLiveAt(nextStatus, previousPublished);
    return !previousPublished.wentLiveAt && Boolean(nextWentLiveAt);
  }

  return previousPublished.live === true;
}

async function fetchKickAppAccessToken(config, tokenCache) {
  if (!config.kickClientId || !config.kickClientSecret) {
    throw new Error(
      "Missing Kick credentials. Set KICK_CLIENT_ID and KICK_CLIENT_SECRET in .env."
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.kickClientId,
    client_secret: config.kickClientSecret,
  });

  const response = await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Kick OAuth failed (${response.status}): ${errorBody}`);
  }

  const payload = await response.json();
  const accessToken = payload?.access_token;
  const expiresInSec = Number(payload?.expires_in || 0);
  if (!accessToken || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    throw new Error("Kick OAuth response missing access_token or expires_in.");
  }

  const safetyWindowMs = 30 * 1000;
  tokenCache.accessToken = accessToken;
  tokenCache.expiresAtMs = Date.now() + expiresInSec * 1000 - safetyWindowMs;
}

async function getValidAccessToken(config, tokenState) {
  if (tokenState.cache.accessToken && Date.now() < tokenState.cache.expiresAtMs) {
    return tokenState.cache.accessToken;
  }

  if (!tokenState.requestInFlight) {
    tokenState.requestInFlight = fetchKickAppAccessToken(config, tokenState.cache).finally(() => {
      tokenState.requestInFlight = null;
    });
  }

  await tokenState.requestInFlight;
  return tokenState.cache.accessToken;
}

async function fetchChannelStatusFromKick(config, tokenState) {
  const accessToken = await getValidAccessToken(config, tokenState);
  const url = `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(config.channelSlug)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kick API request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const channel = Array.isArray(payload?.data) ? payload.data[0] : null;
  const stream = channel?.stream ?? null;
  const isLive = Boolean(stream?.is_live);
  const title = isLive ? formatTitleForJson(getTitleFromChannel(channel)) : null;
  const wentLiveAt = isLive ? parseStreamWentLiveAt(stream) : null;

  return { isLive, title, wentLiveAt };
}

function buildConfig() {
  const config = {
    channelSlug: process.env.KICK_CHANNEL_SLUG || "odablock",
    kickClientId: process.env.KICK_CLIENT_ID || "",
    kickClientSecret: process.env.KICK_CLIENT_SECRET || "",
    forceOffline: String(process.env.FORCE_OFFLINE || "").toLowerCase() === "true",
    pollIntervalMs: Number(process.env.KICK_POLL_INTERVAL_MS || 5 * 60 * 1000),
    webhookPort: Number(process.env.WEBHOOK_PORT),
    webhookDomain: process.env.WEBHOOK_DOMAIN,
    broadcasterUserId: process.env.KICK_BROADCASTER_USER_ID ? Number(process.env.KICK_BROADCASTER_USER_ID) : null,
    github: {
      token: process.env.GITHUB_TOKEN || "",
      owner: process.env.GITHUB_OWNER || "",
      repo: process.env.GITHUB_REPO || "",
      branch: process.env.GITHUB_BRANCH || "main",
      filePath: process.env.GITHUB_FILE_PATH || "livestream.json",
      authorName: process.env.GITHUB_COMMIT_AUTHOR_NAME || "",
      authorEmail: process.env.GITHUB_COMMIT_AUTHOR_EMAIL || "",
    },
  };

  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new Error("KICK_POLL_INTERVAL_MS must be a positive number.");
  }

  return config;
}

async function loadBaselineFromGithub(config) {
  try {
    const state = await github.fetchPublishedState(config.github);
    const normalized = normalizePublishedStatus(state.parsed);
    return { lastPublished: normalized, sha: state.sha };
  } catch (error) {
    console.error(
      `Failed to read current livestream.json from GitHub: ${error instanceof Error ? error.message : String(error)}`
    );
    return { lastPublished: null, sha: null };
  }
}

async function main() {
  loadEnvFile(path.join(__dirname, ".env"));
  const config = buildConfig();

  const tokenState = {
    cache: { accessToken: "", expiresAtMs: 0 },
    requestInFlight: null,
  };


  const ANNOUNCE_CMD = "!AnnounceRL";
  let notificationSha = null;

  try {
    const notifConfig = { ...config.github, filePath: "custom_notifications.json" };
    const existing = await github.fetchPublishedState(notifConfig);
    notificationSha = existing.sha;
    if (existing.exists) {
      console.log("[notify] Loaded existing custom_notifications.json SHA");
    }
  } catch (error) {
    console.warn(`[notify] Could not load custom_notifications.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  function handleChatMessage(event) {
    const sender = event.sender?.username ?? "unknown";
    if (sender.toLowerCase() !== config.channelSlug.toLowerCase()) return;

    const content = event.content ?? "";
    const time = event.created_at
      ? new Date(event.created_at).toLocaleTimeString("en-US", { hour12: false })
      : new Date().toLocaleTimeString("en-US", { hour12: false });

    console.log(`[chat] ${sender} | ${content} | ${time}`);

    if (content.toLowerCase().startsWith(ANNOUNCE_CMD.toLowerCase())) {
      const message = content.slice(ANNOUNCE_CMD.length).trim();
      if (!message) {
        console.log("[notify] !AnnounceRL used with no message, ignoring.");
        return;
      }
      publishNotification(message);
    }
  }

  async function publishNotification(message) {
    const payload = { 
      message, 
      time: new Date().toISOString() 
    };

    try {
      const result = await github.publishFile(
        config.github,
        "custom_notifications.json",
        payload,
        `Update notification: ${message.slice(0, 50)}`,
        notificationSha
      );
      notificationSha = result.sha;
      console.log(`[notify] Published: "${message}"`);
    } catch (error) {
      console.error(`[notify] Failed to publish: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const baseline = await loadBaselineFromGithub(config);
  let lastPublished = baseline.lastPublished;
  let currentSha = baseline.sha;
  let statusUpdateInFlight = null;

  async function applyStatusAndMaybePublish(trigger, nextStatus) {
    if (statusUpdateInFlight) return statusUpdateInFlight;

    statusUpdateInFlight = (async () => {
      if (!shouldPublishStatus(lastPublished, nextStatus)) {
        console.log(`[${trigger}] No livestream.json changes needed.`);
        return;
      }

      const previous = lastPublished;
      const payload = toPublishedStatus({
        ...nextStatus,
        wentLiveAt: resolveWentLiveAt(nextStatus, previous),
      });
      const result = await github.publishStatus(config.github, payload, currentSha);
      lastPublished = payload;
      if (result.sha) currentSha = result.sha;

      if (payload.live) {
        const previousTitle = previous?.live ? previous.title ?? "" : "";
        const wentLiveSuffix = payload.wentLiveAt ? ` (went live ${payload.wentLiveAt})` : "";
        console.log(
          `[${trigger}] livestream.json published: "${previousTitle}" -> "${payload.title ?? ""}"${wentLiveSuffix}`
        );
      } else {
        console.log(`[${trigger}] livestream.json published: stream is now offline.`);
      }
    })().finally(() => {
      statusUpdateInFlight = null;
    });

    return statusUpdateInFlight;
  }

  async function pollAndMaybePublish(trigger) {
    const nextStatus = config.forceOffline
      ? { isLive: false, title: null, wentLiveAt: null }
      : await fetchChannelStatusFromKick(config, tokenState);

    return applyStatusAndMaybePublish(trigger, nextStatus);
  }

  function handleLivestreamWebhook(eventType, payload) {
    if (config.forceOffline) return;

    if (!isEventForMonitoredChannel(payload, config.channelSlug)) {
      console.log(`[webhook] Ignoring ${eventType} for unrelated channel.`);
      return;
    }

    let nextStatus;
    if (eventType === kickWebhook.LIVESTREAM_STATUS_EVENT) {
      nextStatus = statusFromLivestreamStatusEvent(payload);
    } else if (eventType === kickWebhook.LIVESTREAM_METADATA_EVENT) {
      if (!lastPublished?.live) {
        console.log("[webhook] Ignoring metadata update while stream appears offline.");
        return;
      }
      nextStatus = statusFromLivestreamMetadataEvent(payload);
      if (!nextStatus) return;
    } else {
      return;
    }

    applyStatusAndMaybePublish(`webhook:${eventType}`, nextStatus).catch((error) => {
      console.error(
        `[webhook] Failed to publish livestream status: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  kickWebhook.createWebhookServer(config, {
    onChatMessage: handleChatMessage,
    onLivestreamEvent: handleLivestreamWebhook,
  });

  const requiredEvents = [
    "chat.message.sent",
    kickWebhook.LIVESTREAM_STATUS_EVENT,
    kickWebhook.LIVESTREAM_METADATA_EVENT,
  ];

  try {
    let broadcasterUserId = config.broadcasterUserId;
    if (!broadcasterUserId) {
      broadcasterUserId = await kickWebhook.resolveBroadcasterUserId(config, tokenState, getValidAccessToken);
      console.log(`[webhook] Resolved broadcaster user ID: ${broadcasterUserId}`);
    }

    const existing = await kickWebhook.listEventSubscriptions(
      config,
      tokenState,
      getValidAccessToken,
      broadcasterUserId
    );
    const subscribedEvents = new Set(existing.map((sub) => sub.event));
    const missingEvents = requiredEvents.filter((event) => !subscribedEvents.has(event));

    if (missingEvents.length === 0) {
      console.log("[webhook] Already subscribed to all required events.");
    } else {
      await kickWebhook.subscribeToEvents(
        config,
        tokenState,
        getValidAccessToken,
        broadcasterUserId,
        missingEvents
      );
    }
  } catch (error) {
    console.error(
      `[webhook] Event subscription setup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error("[webhook] The webhook server is still running — backup polling will continue.");
  }

  await pollAndMaybePublish("initial").catch((error) => {
    console.error(
      `Initial Kick poll failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  setInterval(() => {
    pollAndMaybePublish("scheduled").catch((error) => {
      console.error(
        `Scheduled Kick poll failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, config.pollIntervalMs);
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
