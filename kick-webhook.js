const crypto = require("crypto");
const express = require("express");

let cachedPublicKey = null;

async function fetchKickPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;

  const response = await fetch("https://api.kick.com/public/v1/public-key", {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch Kick public key (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const pem = payload?.data?.public_key;
  if (!pem || typeof pem !== "string") {
    throw new Error("Kick public key response missing data.public_key");
  }

  cachedPublicKey = pem;
  return cachedPublicKey;
}

async function verifyWebhookSignature(messageId, timestamp, rawBody, signatureBase64) {
  const publicKeyPem = await fetchKickPublicKey();
  const signaturePayload = Buffer.from(`${messageId}.${timestamp}.${rawBody}`);
  const signatureBuffer = Buffer.from(signatureBase64, "base64");

  const isValid = crypto.verify(
    "sha256",
    signaturePayload,
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    signatureBuffer
  );

  return isValid;
}

async function resolveBroadcasterUserId(config, tokenState, getValidAccessToken) {
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
    throw new Error(`Failed to resolve broadcaster user ID (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const channel = Array.isArray(payload?.data) ? payload.data[0] : null;
  const userId = channel?.broadcaster_user_id;

  if (!userId) {
    throw new Error(`Could not find broadcaster_user_id for slug "${config.channelSlug}"`);
  }

  return userId;
}

const LIVESTREAM_STATUS_EVENT = "livestream.status.updated";
const LIVESTREAM_METADATA_EVENT = "livestream.metadata.updated";

async function subscribeToEvents(config, tokenState, getValidAccessToken, broadcasterUserId, eventNames) {
  if (!eventNames.length) return null;

  const accessToken = await getValidAccessToken(config, tokenState);

  const body = {
    events: eventNames.map((name) => ({ name, version: 1 })),
    broadcaster_user_id: broadcasterUserId,
    method: "webhook",
  };

  const response = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to subscribe to Kick events (${response.status}): ${errorBody}`);
  }

  const payload = await response.json();
  console.log(
    `[webhook] Subscribed to events: ${eventNames.join(", ")}`,
    JSON.stringify(payload?.data ?? [], null, 2)
  );
  return payload;
}

async function listEventSubscriptions(config, tokenState, getValidAccessToken, broadcasterUserId) {
  const accessToken = await getValidAccessToken(config, tokenState);
  const url = `https://api.kick.com/public/v1/events/subscriptions?broadcaster_user_id=${broadcasterUserId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to list event subscriptions (${response.status}): ${body}`);
  }

  const payload = await response.json();
  return payload?.data ?? [];
}

function createWebhookServer(config, handlers) {
  const { onChatMessage, onLivestreamEvent } = handlers;
  const app = express();

  app.post("/kick/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const messageId = req.headers["kick-event-message-id"];
    const subscriptionId = req.headers["kick-event-subscription-id"];
    const signature = req.headers["kick-event-signature"];
    const timestamp = req.headers["kick-event-message-timestamp"];
    const eventType = req.headers["kick-event-type"];
    const eventVersion = req.headers["kick-event-version"];

    if (!messageId || !signature || !timestamp || !eventType) {
      console.warn("[webhook] Missing required Kick headers, rejecting request.");
      return res.status(400).json({ error: "Missing required Kick event headers" });
    }

    try {
      const isValid = await verifyWebhookSignature(messageId, timestamp, rawBody, signature);
      if (!isValid) {
        console.warn("[webhook] Invalid signature, rejecting request.");
        return res.status(401).json({ error: "Invalid signature" });
      }
    } catch (error) {
      console.error(`[webhook] Signature verification error: ${error instanceof Error ? error.message : String(error)}`);
      return res.status(500).json({ error: "Signature verification failed" });
    }
    res.status(200).json({ ok: true });
    let eventPayload;
    try {
      eventPayload = JSON.parse(rawBody);
    } catch {
      console.error("[webhook] Failed to parse event body as JSON.");
      return;
    }

    if (eventType === "chat.message.sent") {
      try {
        onChatMessage(eventPayload);
      } catch (error) {
        console.error(`[webhook] Chat message handler error: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (
      eventType === LIVESTREAM_STATUS_EVENT ||
      eventType === LIVESTREAM_METADATA_EVENT
    ) {
      if (onLivestreamEvent) {
        try {
          onLivestreamEvent(eventType, eventPayload);
        } catch (error) {
          console.error(
            `[webhook] Livestream handler error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } else {
      console.log(`[webhook] Received event: ${eventType} (v${eventVersion}) [${messageId}]`);
    }
  });

  const port = config.webhookPort;
  app.listen(port, () => {
    console.log(`[webhook] Server listening on port ${port}`);
    console.log(`[webhook] Webhook URL: https://${config.webhookDomain}/kick/webhook`);
  });

  return app;
}

module.exports = {
  createWebhookServer,
  subscribeToEvents,
  listEventSubscriptions,
  resolveBroadcasterUserId,
  verifyWebhookSignature,
  LIVESTREAM_STATUS_EVENT,
  LIVESTREAM_METADATA_EVENT,
};
