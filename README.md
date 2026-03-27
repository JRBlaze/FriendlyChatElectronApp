# Friendly Chat

A desktop app that merges live chat from Twitch, YouTube, and Kick into one unified window. Built with Electron.

![Platform Support](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-blue)
![Version](https://img.shields.io/badge/version-1.0.0-green)

---

## What it does

Friendly Chat lets you watch and participate in Twitch, YouTube, and Kick chats all in one place — no switching between browser tabs. Connect your accounts once and you're good to go.

- View all three chats merged into a single feed
- Filter to show only the platforms you want
- Send messages to one, some, or all platforms at once
- Loads recent chat history when you join a channel
- Full emote support including BTTV, 7TV, and native platform emotes
- Tab autocomplete for emotes (`:emote`) and mentions (`@username`)
- Click a username to reply, timeout, ban, or delete messages
- Adjustable font size that saves between sessions

---

## Download

Grab the latest installer for your platform from the [Releases](../../releases) page:

- **Windows** — `Friendly-Chat-Setup-x.x.x.exe`
- **Mac** — `Friendly-Chat-x.x.x-arm64.dmg`
- **Linux** — `Friendly-Chat-x.x.x.AppImage`

No setup required — just install and launch.

---

## Getting started

1. Launch Friendly Chat
2. Click **Accounts** and connect Twitch, YouTube, and/or Kick
3. Type a channel name or YouTube video ID and click **Join**
4. Start chatting!

You can watch and read chats without signing in. Signing in is only required to send messages.

---

## Development

To run from source:

```bash
git clone https://github.com/JRBlaze/FriendlyChatElectronApp.git
cd FriendlyChatElectronApp
npm install
npm start
```

To build an installer:

```bash
npm run build        # Windows
npm run build:mac    # Mac
npm run build:linux  # Linux
```

---

## Built with

- [Electron](https://www.electronjs.org)
- [Twitch IRC](https://dev.twitch.tv/docs/irc/)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)
- [Kick Pusher WebSocket](https://kick.com)
- [BTTV](https://betterttv.com) / [7TV](https://7tv.app) emotes
- [recent-messages.robotty.de](https://recent-messages.robotty.de) for Twitch chat history
