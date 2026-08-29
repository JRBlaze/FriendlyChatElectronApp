# Friendly Chat

A desktop app that merges live chat from Twitch, Kick and YouTube into one unified window. Built with Electron.

![Platform Support](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-blue)
![Version](https://img.shields.io/badge/version-1.4.1-green)

## What it does

Friendly Chat lets you watch and participate in Twitch, Kick and YouTube chats in one place.

- View Twitch, Kick and YouTube chat in a single merged feed
- Join the same channel name on every platform at once with **Join all**
- Open a YouTube live chat from a channel name or `@handle` — no need to hunt down the livestream URL
- Filter the feed by platform
- Send messages to Twitch and Kick at once (YouTube sends from its own panel)
- Load recent chat history when you join a channel, with the original timestamps
- Reopen recently joined channels from a local recent-chat list
- Emotes from every source each platform supports: Twitch global/channel/sub/follower emotes, Kick global, emoji and channel emotes, YouTube emoji and channel member emotes, plus 7TV, BTTV and FrankerFaceZ
- Kick's full emote list loads the moment you join, and its global set is cached so it is there before you join anything
- Sound and/or desktop notification when your name is mentioned, each toggled separately
- Tab autocomplete for emotes (`:emote`) and mentions (`@username`), plus a searchable emote picker
- Hover any emote — in the feed, the picker or the autocomplete — for a large preview with its name and where it came from
- `/me` renders as an action, not as the raw `ACTION` wrapper Twitch sends it in
- Replies say what they are answering, quoted above the reply with its emotes intact
- First messages are marked, on the platform's own say-so rather than a guess
- Usernames wear the colour their owner picked, nudged until it is readable on whichever theme you are using
- `@mentions` of other people are drawn in that person's own colour, once this feed has seen them speak
- Click a username to reply, timeout, ban, or delete messages — a reply threads onto the original on Twitch rather than only @mentioning them
- Adjustable font size that saves between sessions
- Light, dark, and match-system theme modes
- Tells you when a new release is on GitHub and installs it for you

![App Screenshot](FCScreenshot.png)

## Download

Grab the latest installer for your platform from the [Releases](../../releases) page.

### Mac Installation Note

If you see **"Friendly Chat is damaged and can't be opened"** when launching on Mac, this is due to Apple's Gatekeeper blocking unsigned apps. To fix it, open **Terminal** and run:

```
xattr -cr /Applications/Friendly\ Chat.app
```

Then try opening the app again. Alternatively go to **System Settings → Privacy & Security** and click **Open Anyway** if the option appears there.

## Getting started

1. Launch Friendly Chat
2. Click **Accounts** and connect Twitch and/or Kick
3. Type a channel name and click **Join**, or use the **ALL** box and **Join all** to open the same name on every platform at once
4. For YouTube, type the channel name, its `@handle`, or a livestream URL — Friendly Chat finds whatever that channel is streaming right now

You can watch and read chats without signing in. Signing in is only required to send messages.

## Mention alerts

Open **Settings** to choose what happens when someone says your name:

- **Play a sound** — a short chime generated in the app, with a volume slider. No sound file to install.
- **Show a desktop notification** — uses your operating system's notification centre.

The two toggles are independent, so you can have sound only, notification only, both, or neither. Your connected Twitch and Kick account names are always highlighted; add any other names you go by in **Extra names to highlight**.

Alerts are rate limited to one every 1.2 seconds, and channel history replayed on join never triggers them.

## Emotes

Every emote a platform exposes is fetched up front when you join, so the picker and `:name` autocomplete are complete immediately — nothing waits for somebody to post an emote first.

Emotes are drawn everywhere a viewer typed one, not only in ordinary chat messages: the message under
a resub, the text of an announcement and the original quoted above a reply all go through the same
renderer a chat message does. The summary wrapped around an event does not — so a display name that
happens to spell an emote name stays a name rather than turning into a picture.

Kick needs a little care because its emote endpoint sits behind Cloudflare. Friendly Chat asks for it through a hidden Electron window that carries the app's own session (so a channel you subscribe to returns its subscriber emotes), falls back to the local server in browser mode, tries both of Kick's emote paths, and retries a couple of times if the first request is turned away. Kick's global and emoji sets are cached separately from channel sets, so they are restored at startup with no channel joined. Collecting emotes from live messages still exists, but only as a last resort.

## Updates

Friendly Chat checks GitHub for a newer release on launch and every six hours. When one exists, a banner appears at the top of the window with the version, the release notes behind a **What's new** toggle, and one button that does the work:

- **Windows** — downloads the installer with a progress bar and launches it, then closes the app so the installer can replace it.
- **macOS** — downloads the `.dmg` and opens it, ready for you to drag Friendly Chat into Applications.
- **Linux** — downloads the new `.AppImage`, makes it executable and opens the folder containing it.

Nothing downloads or installs on its own; the banner just gets you there in two clicks. **Later** hides the banner until the next check, **Skip this version** silences that particular release for good, and **Settings → Updates** has a manual *Check for updates now*, a toggle to stop checking automatically, and a way to clear a skipped version.

The app deliberately does not use electron-updater. Its silent self-update needs a code-signed application, and the macOS builds here are unsigned, so it would work on two platforms out of three and fail confusingly on the third. Downloading the installer and handing it to the operating system behaves identically everywhere and adds no runtime dependency.

## Performance

**Settings → Performance** controls how many messages the feed keeps (200–5000, default 500). Older messages are dropped so a stream you leave open all day stays responsive. You can also turn off the message fade-in animation for the smoothest scrolling on very busy channels.

## How YouTube works

YouTube has no public chat API that works from a channel name alone, and a browser cannot read youtube.com directly because of cross-origin rules. Friendly Chat's local server does the work instead:

1. It loads the channel's `/live` page to find the video that is streaming now.
2. It reads the live chat page once for YouTube's own continuation token.
3. It long-polls YouTube's live chat endpoint and hands normalized messages back to the app.

No API key, OAuth client or third-party service is involved. Messages, author badges, Super Chats, memberships and custom channel emoji all render in the merged feed.

The panel on the right still embeds YouTube's own chat widget. That is what you use to *send* YouTube messages: click **Sign in**, complete browser sign-in, and use the composer inside the panel. The shared message box remains Twitch and Kick only, because sending to YouTube would require a Google OAuth client.

If YouTube changes its payloads or the stream ends, the merged feed says so and the panel keeps working on its own.

## Development

```
npm install
npm start      # run the app
npm test       # run the full offline test suite
```

The test suite loads the real `friendly-chat.html` into jsdom with the network stubbed, then drives the app the way a user would: joining channels on all three platforms, rendering emotes from every source, filtering, sending, moderating, autocompleting, changing settings, and pushing thousands of messages through the feed to check it stays bounded. The server and YouTube parsers are covered separately. Nothing in the suite touches the network.

Run one suite with `node tests/run.js <name>` (`youtube`, `updater`, `server`, `render`, `app`, `perf`).

## Built with

- [Electron](https://www.electronjs.org)
- [Twitch IRC](https://dev.twitch.tv/docs/irc/)
- [Kick Pusher WebSocket](https://kick.com)
- YouTube live chat (the same endpoint youtube.com's own chat page uses)
- [BTTV](https://betterttv.com) / [7TV](https://7tv.app) / [FrankerFaceZ](https://www.frankerfacez.com) emotes
- [recent-messages.robotty.de](https://recent-messages.robotty.de) for Twitch chat history
