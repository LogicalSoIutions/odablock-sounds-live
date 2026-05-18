# Odablock Live Status & Announcer

This repository contains a Node.js service that monitors a Kick.com stream status and chat, and publishes updates to GitHub. It's designed to act as a lightweight backend, automatically updating JSON files in a public repository so that frontend applications (like RuneLite, soundboards or notification overlays) can fetch the latest stream state and announcements without needing their own servers.

## Features

*   **Livestream Status Polling:** Regularly checks a specified Kick channel (e.g., `odablock`) to see if they are live and updates `livestream.json` with the current status and stream title.
*   **Chat Command Webhook:** Listens via Kick Webhooks for chat messages. If the broadcaster types a command like `!AnnounceRL <message>`, it automatically publishes that message to `custom_notifications.json`.
*   **GitHub Integration:** Uses the GitHub API to commit changes directly to the repository, providing a serverless "database" for frontends.

## Setup

1.  Clone the repository.
2.  Install dependencies: `npm install`
3.  Copy `.env.example` to `.env` and fill in the required values.

### Environment Variables

| Variable | Description |
| :--- | :--- |
| `KICK_CHANNEL_SLUG` | The Kick channel to monitor (default: `odablock`). |
| `KICK_CLIENT_ID` | Kick App Client ID for API access. |
| `KICK_CLIENT_SECRET` | Kick App Client Secret. |
| `WEBHOOK_PORT` | Port for the local webhook listener (e.g., `13450`). |
| `WEBHOOK_DOMAIN` | The public domain where the webhook can be reached. |
| `GITHUB_TOKEN` | A GitHub Personal Access Token with repo access. |
| `GITHUB_OWNER` | The owner of the target GitHub repository. |
| `GITHUB_REPO` | The target GitHub repository name. |

*(See `.env.example` or the code for additional configuration options like polling intervals and specific GitHub settings).*

## Usage

Start the service:

```bash
npm start
```

Once running, the service will:
1. Start polling the Kick API based on the `KICK_POLL_INTERVAL_MS` to update `livestream.json`.
2. Start an Express webhook server on `WEBHOOK_PORT`.
3. Automatically subscribe to the `chat.message.sent` Kick event (if not already subscribed) and listen for the `!AnnounceRL` command in chat to update `custom_notifications.json`.
