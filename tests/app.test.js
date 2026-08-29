const { launchApp } = require('./helpers/harness');

let app;

async function boot(options) {
  if (app) app.close();
  app = await launchApp(options);
  return app;
}

const KICK_CHANNEL = {
  id: 90,
  user_id: 4242,
  chatroom: { id: 777 },
};

function stubKick(a, channel = KICK_CHANNEL) {
  a.fetch.route(url => url.includes('kick.com/api/v1/channels/'), () => channel);
  a.fetch.route('/kick-emotes', () => ({ data: [] }));
  a.fetch.route(url => url.includes('kick.com/api/v2/channels/'), () => ({ data: { messages: [] } }));
  a.fetch.route(url => url.includes('7tv.io'), () => ({ emotes: [] }));
}

function stubTwitchApis(a) {
  a.fetch.route(url => url.includes('helix/chat/badges'), () => ({ data: [] }));
  a.fetch.route(url => url.includes('helix/chat/emotes'), () => ({ data: [] }));
  a.fetch.route(url => url.includes('helix/users'), () => ({ data: [{ id: '1000', login: 'broadcaster', display_name: 'Broadcaster' }] }));
  a.fetch.route(url => url.includes('recent-messages.robotty.de'), () => ({ messages: [] }));
  a.fetch.route(url => url.includes('7tv.io') || url.includes('betterttv') || url.includes('frankerfacez'), () => ({ emotes: [] }));
}

// Drives a Twitch socket to the "joined" state.
async function joinTwitch(a, channel = 'somestreamer', { stub = true } = {}) {
  if (stub) stubTwitchApis(a);
  a.type('#ci-twitch', channel);
  a.click('#jb-twitch');
  const ws = a.ws.byUrl('irc-ws.chat.twitch.tv').pop();
  ws.open();
  ws.emit(`:tmi.twitch.tv 366 justinfan12345 #${channel} :End of /NAMES list\r\n`);
  await a.tick(2);
  return ws;
}

describe('app: startup', () => {
  it('shows the connect screen first and skips into chat', async () => {
    const a = await boot();
    assert(!a.$('#oauth-overlay').classList.contains('hidden'), 'connect screen should be visible');
    a.click('.skip-btn');
    assert(a.$('#oauth-overlay').classList.contains('hidden'));
    assert(!a.$('#main-app').classList.contains('hidden'));
  });

  it('skips the connect screen when a session is already stored', async () => {
    const a = await boot({
      storage: { twitch_access_token: 'stored-token' },
      routes: [['id.twitch.tv/oauth2/validate', () => ({ client_id: 'x' })]],
    });
    await a.tick(3);
    assert(a.$('#oauth-overlay').classList.contains('hidden'), 'stored session should skip the prompt');
  });

  it('loads the twitch client id from /config into the auth url', async () => {
    const a = await boot();
    assertIncludes(a.api().CFG.twitch.url, 'client_id=test-twitch-client');
    assertIncludes(a.api().CFG.twitch.url, 'moderator%3Amanage%3Abanned_users');
  });

  it('restores a stored kick session by refreshing the token', async () => {
    const a = await boot({
      storage: { kick_refresh_token: 'r1' },
      routes: [['/kick-refresh', () => ({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })]],
    });
    await a.tick(4);
    assertEqual(a.api().S.auth.kick, true);
    assertEqual(a.window.localStorage.getItem('kick_access_token'), 'fresh');
  });

  it('drops a stored kick session the proxy rejects', async () => {
    const a = await boot({
      storage: { kick_refresh_token: 'bad' },
      routes: [['/kick-refresh', () => ({ error: 'invalid_grant' })]],
    });
    await a.tick(4);
    assertEqual(a.api().S.auth.kick, false);
    assertEqual(a.window.localStorage.getItem('kick_refresh_token'), null);
  });

  it('has no unhandled page errors during startup', async () => {
    const a = await boot();
    assertEqual(a.consoleErrors.length, 0);
  });
});

describe('app: twitch channel', () => {
  it('joins, authenticates anonymously and reports the connection', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a, 'somestreamer');

    assertIncludes(ws.sent.join('\n'), 'CAP REQ :twitch.tv/tags twitch.tv/commands');
    assertIncludes(ws.sent.join('\n'), 'PASS oauth:justinfan12345');
    assertIncludes(ws.sent.join('\n'), 'JOIN #somestreamer');
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'Connected to Twitch: somestreamer');
    assertEqual(a.$('#jb-twitch').textContent, 'Leave');
  });

  it('renders an incoming message with badges and emotes', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@badges=moderator/1;display-name=Mod;emotes=25:0-4;id=m1;user-id=7 :mod!mod@mod.tmi.twitch.tv PRIVMSG #somestreamer :Kappa hi\r\n');
    a.flush();
    const msg = a.$('#feed .msg[data-platform="twitch"]');
    assertEqual(msg.querySelector('.m-author').dataset.user, 'Mod');
    assertEqual(msg.dataset.msgId, 'm1');
    assertIncludes(msg.querySelector('.badge').textContent, 'MOD');
    assertIncludes(msg.querySelector('.m-body').innerHTML, 'emoticons/v2/25');
  });

  it('does not swallow a message that merely contains a command name', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit(':bob!bob@bob.tmi.twitch.tv PRIVMSG #somestreamer :what does USERSTATE mean\r\n');
    a.flush();
    assertIncludes(a.$('#feed .msg .m-body').textContent, 'what does USERSTATE mean');
  });

  it('turns subs and raids into event rows, not chat messages', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@msg-id=resub;display-name=Sarah;msg-param-cumulative-months=12 :tmi.twitch.tv USERNOTICE #somestreamer :love this stream\r\n');
    a.flush();
    assertEqual(a.$$('#feed .msg').length, 0);
    assertIncludes(a.$('#feed .sys-msg.event').textContent, 'Sarah resubscribed (12 months)');
  });

  it('dims messages when a viewer is timed out', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit(':troll!troll@troll.tmi.twitch.tv PRIVMSG #somestreamer :spam spam\r\n');
    a.flush();
    ws.emit('@ban-duration=600 :tmi.twitch.tv CLEARCHAT #somestreamer :troll\r\n');
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'deleted');
    assertIncludes(a.$('#feed').textContent, 'troll was timed out for 600s');
  });

  it('deletes a single message on CLEARMSG', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@id=zap :bob!bob@bob.tmi.twitch.tv PRIVMSG #somestreamer :oops\r\n');
    a.flush();
    ws.emit('@target-msg-id=zap :tmi.twitch.tv CLEARMSG #somestreamer :oops\r\n');
    assertIncludes(a.$('#feed .msg').className, 'deleted');
  });

  it('reconnects with backoff after an unexpected drop', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    const before = a.ws.byUrl('irc-ws.chat.twitch.tv').length;
    ws.close();
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'disconnected');
    assertIncludes(a.$('#feed').textContent, 'reconnecting in 2s');
    assertEqual(a.ws.byUrl('irc-ws.chat.twitch.tv').length, before, 'reconnect must be scheduled, not immediate');
  });

  it('does not announce a disconnect when the user leaves', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    a.click('#jb-twitch');
    a.flush();
    assertNotIncludes(a.$('#feed').textContent, 'disconnected');
    assertIncludes(a.$('#feed').textContent, 'Left Twitch channel');
    assertEqual(a.api().S.channels.twitch, null);
  });

  it('deduplicates history that also arrives live', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    const line = '@id=dup;display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #somestreamer :hello\r\n';
    ws.emit(line);
    ws.emit(line);
    a.flush();
    assertEqual(a.$$('#feed .msg').length, 1);
  });
});

describe('app: kick channel', () => {
  it('joins, subscribes to the chatroom and renders messages', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(3);

    const ws = a.ws.byUrl('pusher.com').pop();
    assert(ws, 'expected a pusher socket');
    ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await a.tick(2);
    assertIncludes(ws.sent.join('\n'), 'chatrooms.777.v2');
    assertIncludes(ws.sent.join('\n'), 'channel.90');
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'Connected to Kick: kickstreamer');
    assertEqual(a.api().S.kickBroadcasterId, 4242);

    ws.emit(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({
        id: 'k1',
        content: 'hey [emote:5:kickHi]',
        sender: { id: 3, username: 'KickFan', identity: { badges: [{ type: 'moderator' }] } },
      }),
    }));
    a.flush();
    const msg = a.$('#feed .msg[data-platform="kick"]');
    assertEqual(msg.querySelector('.m-author').dataset.user, 'KickFan');
    assertIncludes(msg.querySelector('.badge').textContent, 'MOD');
    assertIncludes(msg.querySelector('.m-body').innerHTML, 'files.kick.com/emotes/5/fullsize');
  });

  it('turns kick platform events into event rows', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(3);
    const ws = a.ws.byUrl('pusher.com').pop();
    ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await a.tick(2);
    ws.emit(JSON.stringify({
      event: 'App\\Events\\GiftedSubscriptionsEvent',
      data: JSON.stringify({ gifter_username: 'Gifter', gifted_usernames: ['a', 'b', 'c'] }),
    }));
    a.flush();
    assertIncludes(a.$('#feed .sys-msg.event[data-platform="kick"]').textContent, 'Gifter gifted 3 subs');
  });

  it('answers pusher pings so the socket is not dropped', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(3);
    const ws = a.ws.byUrl('pusher.com').pop();
    ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await a.tick(1);
    ws.sent.length = 0;
    ws.emit(JSON.stringify({ event: 'pusher:ping', data: '{}' }));
    assertIncludes(ws.sent.join(''), 'pusher:pong');
  });

  it('reports a channel that cannot be found', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.fetch.route(url => url.includes('kick.com/api/v1/channels/'), () => a.fetch.json({ error: 'nope' }, 404));
    a.type('#ci-kick', 'ghost');
    a.click('#jb-kick');
    await a.tick(3);
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'could not load channel');
  });
});

describe('app: youtube channel', () => {
  function stubYouTube(a, { messages = [], emotes = {} } = {}) {
    a.fetch.route('/youtube-resolve', () => ({ videoId: 'dQw4w9WgXcQ', channelName: 'Test Channel' }));
    a.fetch.route('/youtube-chat', () => ({
      messages, removals: [], continuation: 'NEXT', pollMs: 5000, ended: false,
      emotes, bootstrapped: true, title: 'Live now',
    }));
  }

  it('resolves a plain channel name and merges chat into the feed', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubYouTube(a, {
      messages: [{
        kind: 'message', id: 'y1', author: 'YT Viewer', authorChannelId: 'UC1',
        badges: [{ type: 'moderator', label: 'Moderator', iconUrl: '' }],
        runs: [{ type: 'text', text: 'hello from youtube' }],
        timestampUsec: '1700000000000000',
      }],
      emotes: { ':_cozy:': { url: 'https://yt3.ggpht.com/cozy.png', source: 'YouTube Channel' } },
    });

    a.type('#ci-youtube', 'somechannel');
    a.click('#jb-youtube');
    await a.tick(4);
    a.flush();

    const resolveCall = a.fetch.callsTo('/youtube-resolve')[0];
    assertIncludes(resolveCall.url, 'q=somechannel');
    assertIncludes(a.$('#feed').textContent, 'Connected to YouTube: somechannel');

    const msg = a.$('#feed .msg[data-platform="youtube"]');
    assertEqual(msg.querySelector('.m-author').dataset.user, 'YT Viewer');
    assertIncludes(msg.querySelector('.m-body').textContent, 'hello from youtube');
    assertIncludes(msg.querySelector('.yt-badge-label').textContent, 'moderator');
    assertEqual(a.api().S.nativeEmotes.youtube[':_cozy:'].url, 'https://yt3.ggpht.com/cozy.png');
  });

  it('points the side panel at the resolved stream', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubYouTube(a);
    a.type('#ci-youtube', '@somechannel');
    a.click('#jb-youtube');
    await a.tick(4);
    const frame = a.$('#youtube-chat');
    assertEqual(frame.dataset.videoId, 'dQw4w9WgXcQ');
    assertIncludes(frame.getAttribute('src'), 'live_chat?v=dQw4w9WgXcQ');
    assert(!frame.classList.contains('hidden'));
  });

  it('accepts a pasted livestream URL without contacting the server', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubYouTube(a);
    a.type('#ci-youtube', 'https://www.youtube.com/watch?v=abcdefghijk');
    a.click('#jb-youtube');
    await a.tick(4);
    assertEqual(a.fetch.callsTo('/youtube-resolve').length, 0);
    assertEqual(a.$('#youtube-chat').dataset.videoId, 'abcdefghijk');
  });

  it('falls back to the Electron resolver when the server cannot resolve', async () => {
    const a = await boot({
      electronAPI: {
        resolveYouTubeChannel: async () => ({ videoId: 'zyxwvutsrqp', channelName: 'Hidden' }),
      },
    });
    a.click('.skip-btn');
    a.fetch.route('/youtube-resolve', () => a.fetch.json({ error: 'blocked' }, 404));
    a.fetch.route('/youtube-chat', () => ({ messages: [], continuation: '', pollMs: 5000, ended: true }));
    a.type('#ci-youtube', 'somechannel');
    a.click('#jb-youtube');
    await a.tick(5);
    assertEqual(a.$('#youtube-chat').dataset.videoId, 'zyxwvutsrqp');
  });

  it('explains itself when the channel is offline', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.fetch.route('/youtube-resolve', () => a.fetch.json({ error: 'not live right now' }, 404));
    a.type('#ci-youtube', 'offlinechannel');
    a.click('#jb-youtube');
    await a.tick(4);
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'not live right now');
  });

  it('stops polling and clears the panel on leave', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubYouTube(a);
    a.type('#ci-youtube', 'somechannel');
    a.click('#jb-youtube');
    await a.tick(4);
    a.click('#jb-youtube');
    await a.tick(2);
    assertEqual(a.api().S.youtube.polling, false);
    assertEqual(a.api().S.channels.youtube, null);
    assert(a.$('#youtube-chat').classList.contains('hidden'));
  });

  it('marks deleted youtube messages', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.channels.youtube = 'somechannel';
    a.api().renderYouTubeMessage({ kind: 'message', id: 'y9', author: 'A', authorChannelId: 'UCbad', runs: [{ type: 'text', text: 'x' }] });
    a.flush();
    a.api().applyYouTubeRemoval({ id: 'y9' });
    assertIncludes(a.$('#feed .msg[data-platform="youtube"]').className, 'deleted');
  });
});

describe('app: multi-platform join', () => {
  it('joins every selected platform from one name', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubTwitchApis(a);
    stubKick(a);
    a.fetch.route('/youtube-resolve', () => ({ videoId: 'dQw4w9WgXcQ' }));
    a.fetch.route('/youtube-chat', () => ({ messages: [], continuation: 'N', pollMs: 5000 }));

    a.type('#ci-all', 'sameeverywhere');
    a.click('#mj-btn');
    await a.tick(4);

    assertEqual(a.api().S.channels.twitch, 'sameeverywhere');
    assertEqual(a.api().S.channels.kick, 'sameeverywhere');
    assertEqual(a.api().S.channels.youtube, 'sameeverywhere');
    assertEqual(a.$('#ci-twitch').value, 'sameeverywhere');
  });

  it('respects deselected platforms and remembers the choice', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubTwitchApis(a);
    a.click('#mjp-kick');
    a.click('#mjp-youtube');
    a.type('#ci-all', 'twitchonly');
    a.click('#mj-btn');
    await a.tick(3);

    assertEqual(a.api().S.channels.twitch, 'twitchonly');
    assertEqual(a.api().S.channels.kick, null);
    assertEqual(a.api().S.channels.youtube, null);
    assertEqual(JSON.parse(a.window.localStorage.getItem('multi_join_platforms_v1')), ['twitch']);
  });

  it('restores the saved platform selection on the next launch', async () => {
    const a = await boot({ storage: { multi_join_platforms_v1: JSON.stringify(['kick']) } });
    assert(!a.$('#mjp-twitch').classList.contains('on'));
    assert(a.$('#mjp-kick').classList.contains('on'));
  });

  it('does nothing without a name', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#mj-btn');
    await a.tick(1);
    assertEqual(a.api().S.channels.twitch, null);
  });
});

describe('app: filters, targets and sending', () => {
  it('hides a platform when its filter chip is switched off', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().addMsg('twitch', 'tw', 'from twitch', {});
    a.api().addMsg('kick', 'ki', 'from kick', {});
    a.api().addEvent('kick', 'kick event');
    a.flush();

    a.click('#fc-kick');
    assertEqual(a.$$('#feed [data-platform="kick"].hide').length, 2);
    assertEqual(a.$$('#feed [data-platform="twitch"].hide').length, 0);

    a.click('#fc-all');
    assertEqual(a.$$('#feed .hide').length, 0);
  });

  it('refuses to hide the last visible platform', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#fc-twitch');
    a.click('#fc-kick');
    a.click('#fc-youtube');
    assertEqual(a.api().S.filter.size, 1);
  });

  it('keeps youtube out of the shared send targets', async () => {
    const a = await boot();
    a.click('.skip-btn');
    assertEqual([...a.api().S.target].sort(), ['kick', 'twitch']);
    assertEqual(a.$('#tc-youtube'), null);
  });

  it('sends to every authenticated, joined and selected platform', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubTwitchApis(a);
    stubKick(a);

    const S = a.api().S;
    S.auth.twitch = true; S.tokens.twitch = 'tw-token'; S.twitchUserId = '55';
    S.auth.kick = true;   S.tokens.kick = 'ki-token';   S.kickBroadcasterId = 4242;
    S.channels.twitch = 'chan'; S.channels.kick = 'chan';
    S.twitchBroadcasterId = '1000'; S.twitchBroadcasterChannel = 'chan';

    let twitchBody = null;
    let kickBody = null;
    a.fetch.route('helix/chat/messages', (url, options) => { twitchBody = JSON.parse(options.body); return { data: [{ is_sent: true }] }; });
    a.fetch.route('/kick-send', (url, options) => { kickBody = JSON.parse(options.body); return { is_sent: true }; });

    a.window.document.getElementById('send-input').value = 'hello everyone';
    a.click('#send-btn');
    await a.tick(3);

    assertEqual(twitchBody.message, 'hello everyone');
    assertEqual(twitchBody.broadcaster_id, '1000');
    assertEqual(kickBody.text, 'hello everyone');
    assertEqual(a.$('#send-input').value, '');
  });

  it('explains that youtube messages go through the panel', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const S = a.api().S;
    S.auth.twitch = true; S.tokens.twitch = 't';
    S.channels.youtube = 'somechannel';
    a.window.document.getElementById('send-input').value = 'hi';
    a.click('#send-btn');
    await a.tick(1);
    assertIncludes(a.$('#toast').textContent, 'YouTube panel');
  });

  it('surfaces a twitch send error in the feed', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const S = a.api().S;
    S.auth.twitch = true; S.tokens.twitch = 't'; S.twitchUserId = '55';
    S.channels.twitch = 'chan'; S.twitchBroadcasterId = '1000'; S.twitchBroadcasterChannel = 'chan';
    a.fetch.route('helix/chat/messages', () => a.fetch.json({ message: 'too fast' }, 429));
    a.window.document.getElementById('send-input').value = 'hi';
    a.click('#send-btn');
    await a.tick(3);
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'Twitch send error: too fast');
  });
});

describe('app: autocomplete and emote picker', () => {
  it('suggests emotes after two characters and completes with Tab', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.thirdPartyEmotes.twitch = {
      catJAM: { url: 'https://x/catjam.png', source: '7TV' },
      catKISS: { url: 'https://x/catkiss.png', source: '7TV' },
    };
    a.type('#send-input', ':cat');
    assert(a.$('#autocomplete-popup').classList.contains('visible'), 'popup should be open');
    assertEqual(a.$$('#autocomplete-popup .ac-item').length, 2);
    a.key('#send-input', 'Tab');
    assertEqual(a.$('#send-input').value, 'catJAM ');
  });

  it('suggests recent chatters after @', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().addMsg('twitch', 'SomeViewer', 'hi', {});
    a.flush();
    a.type('#send-input', '@some');
    assertEqual(a.$$('#autocomplete-popup .ac-item').length, 1);
    a.key('#send-input', 'Enter');
    assertEqual(a.$('#send-input').value, '@SomeViewer ');
  });

  it('opens the picker with every platform\'s emotes and filters them', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const S = a.api().S;
    S.nativeEmotes.twitch = { Kappa: { url: 'https://x/kappa.png', source: 'Twitch Global' } };
    S.nativeEmotes.kick = { kickHi: { url: 'https://x/kickhi.png', source: 'Kick Channel' } };
    S.nativeEmotes.youtube = { ':_cozy:': { url: 'https://x/cozy.png', source: 'YouTube Channel' } };
    S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/catjam.png', source: '7TV' } };

    a.click('#emote-btn');
    assertEqual(a.$('#emote-count').textContent, '4');
    assertEqual(a.$$('#emote-results .emote-grid-item').length, 4);
    assertEqual(a.$$('#emote-results .ac-header').length, 4);

    a.type('#emote-search', 'cat');
    assertEqual(a.$$('#emote-results .emote-grid-item').length, 1);

    a.click('#emote-results .emote-grid-item');
    assertEqual(a.$('#send-input').value, 'catJAM ');
  });

  it('tells the user when no emotes are loaded yet', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#emote-btn');
    assertIncludes(a.$('#toast').textContent, 'No emotes loaded yet');
  });

  it('closes on Escape', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/c.png', source: '7TV' } };
    a.type('#send-input', ':cat');
    a.key('#send-input', 'Escape');
    assert(!a.$('#autocomplete-popup').classList.contains('visible'));
  });
});

describe('app: user menu and moderation', () => {
  it('offers reply and details but no moderation without rights', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().addMsg('twitch', 'Someone', 'hi', { userId: '9' });
    a.flush();
    a.click('#feed .m-author');
    const labels = a.$$('#user-menu-actions .um-action').map(b => b.textContent);
    assertEqual(labels.length, 2);
    assertIncludes(labels.join('|'), 'Reply');
    assertNotIncludes(labels.join('|'), 'Ban');
  });

  it('offers moderation once the user is a moderator', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.auth.twitch = true;
    a.api().S.canModerate.twitch = true;
    a.api().addMsg('twitch', 'Someone', 'hi', { userId: '9' });
    a.flush();
    a.click('#feed .m-author');
    const labels = a.$$('#user-menu-actions .um-action').map(b => b.textContent).join('|');
    assertIncludes(labels, 'Ban');
    assertIncludes(labels, 'Timeout 60s');
  });

  it('fills the composer when replying', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().addMsg('kick', 'KickFan', 'hi', {});
    a.flush();
    a.click('#feed .m-author');
    const reply = a.$$('#user-menu-actions .um-action').find(b => b.textContent.includes('Reply'));
    reply.dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
    assertEqual(a.$('#send-input').value, '@KickFan ');
  });

  it('grants moderation from the USERSTATE mod flag', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    assertEqual(a.api().S.canModerate.twitch, false);
    ws.emit('@mod=1;emote-sets=0 :tmi.twitch.tv USERSTATE #somestreamer\r\n');
    assertEqual(a.api().S.canModerate.twitch, true);
  });
});

describe('app: settings', () => {
  it('opens, persists changes and reloads them', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#settings-btn');
    assert(!a.$('#settings-overlay').classList.contains('hidden'));

    a.change('#set-mention-sound', false);
    a.change('#set-nicknames', 'bobby');
    a.change('#set-max-messages', '250');

    const saved = JSON.parse(a.window.localStorage.getItem('friendly_chat_settings_v1'));
    assertEqual(saved.mentionSound, false);
    assertEqual(saved.extraNicknames, 'bobby');
    assertEqual(saved.maxMessages, 250);

    const b = await boot({ storage: { friendly_chat_settings_v1: JSON.stringify(saved) } });
    assertEqual(b.api().settings.mentionSound, false);
    assertEqual(b.$('#set-nicknames').value, '');
    b.click('#settings-btn');
    assertEqual(b.$('#set-nicknames').value, 'bobby');
  });

  it('clamps an out-of-range message limit', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#settings-btn');
    a.change('#set-max-messages', '999999');
    assertEqual(a.api().settings.maxMessages, 5000);
    a.change('#set-max-messages', '1');
    assertEqual(a.api().settings.maxMessages, 200);
  });

  it('ignores a corrupt settings blob', async () => {
    const a = await boot({ storage: { friendly_chat_settings_v1: '{not json' } });
    assertEqual(a.api().settings.maxMessages, 500);
    assertEqual(a.api().settings.mentionSound, true);
  });
});

describe('app: mention alerts', () => {
  it('plays a sound and shows a notification when both are on', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob', {});
    a.flush();
    assert(a.state.tones > 0, 'expected the chime to play');
    assertEqual(a.state.notifications.length, 1);
    assertIncludes(a.state.notifications[0].title, 'someone mentioned you on Twitch');
  });

  it('plays only the sound when notifications are off', async () => {
    const a = await boot({
      storage: { friendly_chat_settings_v1: JSON.stringify({ mentionSound: true, mentionNotify: false }) },
    });
    a.click('.skip-btn');
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob', {});
    assert(a.state.tones > 0);
    assertEqual(a.state.notifications.length, 0);
  });

  it('shows only the notification when the sound is off', async () => {
    const a = await boot({
      storage: { friendly_chat_settings_v1: JSON.stringify({ mentionSound: false, mentionNotify: true }) },
    });
    a.click('.skip-btn');
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob', {});
    assertEqual(a.state.tones, 0);
    assertEqual(a.state.notifications.length, 1);
  });

  it('stays silent when both are off', async () => {
    const a = await boot({
      storage: { friendly_chat_settings_v1: JSON.stringify({ mentionSound: false, mentionNotify: false }) },
    });
    a.click('.skip-btn');
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob', {});
    assertEqual(a.state.tones, 0);
    assertEqual(a.state.notifications.length, 0);
  });

  it('rate limits a burst of mentions', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.twitchUserLogin = 'bob';
    for (let i = 0; i < 25; i++) a.api().addMsg('twitch', 'spammer', `@bob ${i}`, {});
    assertEqual(a.state.notifications.length, 1, 'only one alert should fire in a burst');
  });

  it('does not alert while replaying channel history', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob', { history: true });
    assertEqual(a.state.notifications.length, 0);
    assertEqual(a.state.tones, 0);
  });

  it('fires for youtube mentions too', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().settings.extraNicknames = 'bob';
    a.api().addMsg('youtube', 'YT Viewer', 'nice one bob', { runs: [{ type: 'text', text: 'nice one bob' }] });
    assertIncludes(a.state.notifications[0].title, 'mentioned you on YouTube');
  });
});

describe('app: preferences that persist', () => {
  it('saves and restores the font size', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#fs-plus');
    a.click('#fs-plus');
    assertEqual(a.window.localStorage.getItem('chatFontSize'), '15');
    const b = await boot({ storage: { chatFontSize: '18' } });
    assertEqual(b.$('#fs-input').value, '18');
  });

  it('clamps the font size input', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.change('#fs-input', '99');
    assertEqual(a.$('#fs-input').value, '22');
    a.change('#fs-input', '2');
    assertEqual(a.$('#fs-input').value, '9');
  });

  it('saves the theme choice', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.change('#theme-select', 'light');
    assertEqual(a.window.localStorage.getItem('themeMode'), 'light');
    assertEqual(a.document.documentElement.dataset.theme, 'light');
  });

  it('remembers recent channels per platform', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubTwitchApis(a);
    await joinTwitch(a, 'firstchannel');
    a.click('#jb-twitch');
    a.type('#ci-twitch', 'secondchannel');
    a.click('#jb-twitch');
    await a.tick(1);

    const options = [...a.$('#hist-twitch').options].map(o => o.value);
    assertEqual(options, ['', 'secondchannel', 'firstchannel']);
    assertEqual(a.$('#hist-kick').options.length, 1);
  });

  it('keeps a pasted youtube url intact in recents', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.fetch.route('/youtube-chat', () => ({ messages: [], continuation: '', ended: true }));
    a.type('#ci-youtube', 'https://www.youtube.com/watch?v=AbCdEfGhIjK');
    a.click('#jb-youtube');
    await a.tick(3);
    const options = [...a.$('#hist-youtube').options].map(o => o.value);
    assertIncludes(options.join('|'), 'AbCdEfGhIjK');
  });
});

process.on('exit', () => { if (app) app.close(); });

describe('app: emote loading from every source', () => {
  it('loads twitch global, channel, user, 7TV, BTTV and FFZ emotes on join', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const S = a.api().S;
    S.tokens.twitch = 'tw-token';
    S.auth.twitch = true;
    S.twitchUserId = '55';
    S.twitchUserLogin = 'me';

    a.fetch.route('helix/chat/emotes/global', () => ({ data: [{ id: '25', name: 'Kappa', emote_type: 'globals' }] }));
    a.fetch.route(url => url.includes('helix/chat/emotes?broadcaster_id'), () => ({ data: [{ id: '99', name: 'streamerLove', emote_type: 'subscriptions' }] }));
    a.fetch.route('helix/chat/emotes/user', () => ({ data: [{ id: '77', name: 'myPrimeEmote', emote_type: 'globals' }] }));
    a.fetch.route('helix/chat/emotes/set', () => ({ data: [{ id: '88', name: 'setEmote', emote_type: 'subscriptions' }] }));
    a.fetch.route('helix/chat/badges', () => ({ data: [] }));
    a.fetch.route('helix/users', () => ({ data: [{ id: '1000', login: 'somestreamer', display_name: 'Streamer' }] }));
    a.fetch.route('recent-messages.robotty.de', () => ({ messages: [] }));
    a.fetch.route('7tv.io/v3/emote-sets/global', () => ({ emotes: [{ name: 'catJAM', data: { host: { url: '//cdn.7tv.app/emote/1', files: [{ name: '2x.webp' }] } } }] }));
    a.fetch.route('7tv.io/v3/users/twitch', () => ({ emote_set: { emotes: [{ name: 'peepoHappy', data: { host: { url: '//cdn.7tv.app/emote/2', files: [{ name: '2x.webp' }] } } }] } }));
    a.fetch.route('betterttv.net/3/cached/emotes/global', () => [{ id: 'b1', code: 'monkaS' }]);
    a.fetch.route('betterttv.net/3/cached/users/twitch', () => ({ channelEmotes: [{ id: 'b2', code: 'chanBTTV' }], sharedEmotes: [{ id: 'b3', code: 'sharedBTTV' }] }));
    a.fetch.route('frankerfacez.com/v1/set/global', () => ({ sets: { 3: { emoticons: [{ name: 'ZreknarF', urls: { 1: '//cdn.frankerfacez.com/1', 2: '//cdn.frankerfacez.com/2' } }] } } }));
    a.fetch.route('frankerfacez.com/v1/room/id', () => ({ sets: { 9: { emoticons: [{ name: 'roomFFZ', urls: { 2: '//cdn.frankerfacez.com/9' } }] } } }));

    const ws = await joinTwitch(a, 'somestreamer', { stub: false });
    ws.emit('@mod=0;emote-sets=0,300374282 :tmi.twitch.tv USERSTATE #somestreamer\r\n');
    await a.tick(6);

    const native = S.nativeEmotes.twitch;
    const third = S.thirdPartyEmotes.twitch;
    assertEqual(native.Kappa.url, 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0');
    assert(native.streamerLove, 'channel emotes should load');
    assert(native.myPrimeEmote, 'user emotes should load');
    assert(native.setEmote, 'emote-set emotes should load');
    assertEqual(third.catJAM.url, 'https://cdn.7tv.app/emote/1/2x.webp');
    assert(third.peepoHappy, '7TV channel emotes should load');
    assertEqual(third.monkaS.url, 'https://cdn.betterttv.net/emote/b1/2x');
    assert(third.chanBTTV && third.sharedBTTV, 'BTTV channel + shared emotes should load');
    assertEqual(third.ZreknarF.url, 'https://cdn.frankerfacez.com/2');
    assert(third.roomFFZ, 'FFZ room emotes should load');
  });

  it('loads kick global, emoji and channel emotes through the electron bridge', async () => {
    const a = await boot({
      electronAPI: {
        fetchKickEmotes: async () => ([
          { id: 'emoji', name: 'Emoji', emotes: [{ id: 1, name: 'smile' }] },
          { id: 'Global', name: 'Global', emotes: [{ id: 2, name: 'kickGlobal' }] },
          { id: 42, slug: 'kickstreamer', emotes: [{ id: 3, name: 'streamerHype' }] },
        ]),
      },
    });
    a.click('.skip-btn');
    stubKick(a);
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(5);

    const native = a.api().S.nativeEmotes.kick;
    assertEqual(native.kickGlobal.source, 'Kick Global');
    assertEqual(native.smile.source, 'Kick Emoji');
    assertEqual(native.streamerHype.url, 'https://files.kick.com/emotes/3/fullsize');
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'Loaded 3 Kick emotes');
  });

  it('falls back to the server proxy for kick emotes in browser mode', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.fetch.route('/kick-emotes', () => ({ data: [{ id: 'Global', emotes: [{ id: 8, name: 'serverEmote' }] }] }));
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(5);
    assertEqual(a.api().S.nativeEmotes.kick.serverEmote.url, 'https://files.kick.com/emotes/8/fullsize');
  });

  it('collects kick emotes from live messages when no API is reachable', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.fetch.route('/kick-emotes', () => a.fetch.json({ error: 'blocked' }, 403));
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(4);
    const ws = a.ws.byUrl('pusher.com').pop();
    ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await a.tick(2);
    ws.emit(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({ id: 'k2', content: 'yo [emote:321:passiveEmote]', sender: { id: 1, username: 'Fan' } }),
    }));
    assertEqual(a.api().S.nativeEmotes.kick.passiveEmote.url, 'https://files.kick.com/emotes/321/fullsize');
  });

  it('loads 7TV emotes for a kick channel', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.fetch.route('7tv.io/v3/users/kick', () => ({ emote_set: { emotes: [{ name: 'kick7tv', data: { host: { url: '//cdn.7tv.app/k1', files: [{ name: '2x.webp' }] } } }] } }));
    a.fetch.route('7tv.io/v3/emote-sets/global', () => ({ emotes: [] }));
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(5);
    assertEqual(a.api().S.thirdPartyEmotes.kick.kick7tv.url, 'https://cdn.7tv.app/k1/2x.webp');
  });

  it('does not lose already-loaded emotes when a second fetch runs', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.thirdPartyEmotes.twitch = { existing: { url: 'https://x/e.png', source: '7TV' } };
    a.fetch.route('7tv.io/v3/emote-sets/global', () => ({ emotes: [{ name: 'fresh', data: { host: { url: '//cdn.7tv.app/f', files: [{ name: '2x.webp' }] } } }] }));
    a.fetch.route(url => url.includes('betterttv') || url.includes('frankerfacez'), () => ({}));
    await a.window.eval(`fetchThirdPartyEmotes('twitch', 'chan', null)`);
    await a.tick(3);
    assert(a.api().S.thirdPartyEmotes.twitch.existing, 'existing emotes must survive');
    assert(a.api().S.thirdPartyEmotes.twitch.fresh, 'new emotes must be added');
  });

  it('survives every emote provider being unreachable', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.fetch.route(url => url.includes('7tv') || url.includes('betterttv') || url.includes('frankerfacez'),
      () => { throw new Error('offline'); });
    await a.window.eval(`fetchThirdPartyEmotes('twitch', 'chan', '55')`);
    await a.tick(3);
    assertEqual(a.consoleErrors.length, 0);
    assertEqual(Object.keys(a.api().S.thirdPartyEmotes.twitch).length, 0);
  });
});

describe('app: oauth callback handling', () => {
  it('accepts a twitch token posted back from the popup', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.fetch.route('helix/users', () => ({ data: [{ id: '55', login: 'me', display_name: 'Me' }] }));
    a.fetch.route(url => url.includes('helix/chat'), () => ({ data: [] }));

    a.window.open = () => ({ closed: false, close() {} });
    a.window.eval(`startOAuth('twitch')`);
    a.window.dispatchEvent(new a.window.MessageEvent('message', {
      origin: 'http://localhost:8080',
      data: { type: 'oauth_callback', platform: 'twitch', token: 'tok-123' },
    }));
    await a.tick(3);

    assertEqual(a.api().S.auth.twitch, true);
    assertEqual(a.window.localStorage.getItem('twitch_access_token'), 'tok-123');
    assertEqual(a.api().S.twitchUserLogin, 'me');
    assertEqual(a.$('#btn-twitch').textContent, 'Disconnect');
  });

  it('ignores a message from another origin', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.window.open = () => ({ closed: false, close() {} });
    a.window.eval(`startOAuth('twitch')`);
    a.window.dispatchEvent(new a.window.MessageEvent('message', {
      origin: 'https://evil.example',
      data: { type: 'oauth_callback', platform: 'twitch', token: 'stolen' },
    }));
    await a.tick(2);
    assertEqual(a.api().S.auth.twitch, false);
  });

  it('reports an auth failure without connecting', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.window.open = () => ({ closed: false, close() {} });
    a.window.eval(`startOAuth('twitch')`);
    a.window.dispatchEvent(new a.window.MessageEvent('message', {
      origin: 'http://localhost:8080',
      data: { type: 'oauth_callback', platform: 'twitch', token: null, error: 'access_denied' },
    }));
    await a.tick(2);
    assertEqual(a.api().S.auth.twitch, false);
    assertIncludes(a.$('#toast').textContent, 'access_denied');
    assertEqual(a.$('#btn-twitch').textContent, 'Connect');
  });

  it('builds the kick authorize url from the page origin, not a fixed port', async () => {
    const a = await boot();
    a.click('.skip-btn');
    let opened = '';
    a.window.open = (url) => { opened = url; return { closed: false, close() {} }; };
    await a.window.eval(`startKickOAuth()`);
    await a.tick(2);
    assertIncludes(opened, 'id.kick.com/oauth/authorize');
    assertIncludes(opened, encodeURIComponent('http://localhost:8080/friendly-chat.html'));
    assertIncludes(opened, 'code_challenge_method=S256');
    assert(a.window.localStorage.getItem('kick_verifier'), 'verifier must survive a full page redirect');
  });

  it('disconnects cleanly and clears stored tokens', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.auth.kick = true;
    a.window.localStorage.setItem('kick_refresh_token', 'r');
    a.window.eval(`disconnectPlatform('kick')`);
    assertEqual(a.api().S.auth.kick, false);
    assertEqual(a.window.localStorage.getItem('kick_refresh_token'), null);
    assertEqual(a.$('#st-kick').textContent, 'Not connected');
  });
});

describe('app: autocomplete edge cases', () => {
  it('switches from the picker to typed completion cleanly', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/c.png', source: '7TV' } };
    a.click('#emote-btn');
    assertEqual(a.$('#autocomplete-popup').dataset.mode, 'browse');
    a.type('#send-input', 'hi :cat');
    a.key('#send-input', 'Tab');
    assertEqual(a.$('#send-input').value, 'hi catJAM ');
  });

  it('keeps the picker search text when emotes arrive mid-browse', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/c.png', source: '7TV' } };
    a.click('#emote-btn');
    a.type('#emote-search', 'cat');
    a.api().S.nativeEmotes.kick = { catNAP: { url: 'https://x/n.png', source: 'Kick Channel' } };
    a.window.eval('refreshEmotePickerIfOpen()');
    assertEqual(a.$('#emote-search').value, 'cat');
    assertEqual(a.$$('#emote-results .emote-grid-item').length, 2);
  });
});

describe('app: youtube panel and feed stay in sync', () => {
  it('joining from the panel Load button also merges the chat', async () => {
    const a = await boot({
      routes: [
        ['/youtube-resolve', () => ({ videoId: 'dQw4w9WgXcQ' })],
        ['/youtube-chat', () => ({ messages: [], continuation: 'N', pollMs: 5000, bootstrapped: true })],
      ],
    });
    a.click('.skip-btn');
    a.click('#youtube-toggle');
    a.type('#youtube-url', 'panelchannel');
    a.click('#youtube-load');
    await a.tick(4);

    assertEqual(a.api().S.channels.youtube, 'panelchannel');
    assertEqual(a.$('#ci-youtube').value, 'panelchannel');
    assertEqual(a.$('#jb-youtube').textContent, 'Leave');
    assertEqual(a.$('#youtube-chat').dataset.videoId, 'dQw4w9WgXcQ');
    assert(a.api().S.youtube.polling, 'the merged feed should be polling');
  });

  it('joining from the channel row fills the panel input', async () => {
    const a = await boot({
      routes: [
        ['/youtube-resolve', () => ({ videoId: 'dQw4w9WgXcQ' })],
        ['/youtube-chat', () => ({ messages: [], continuation: 'N', pollMs: 5000 })],
      ],
    });
    a.click('.skip-btn');
    a.type('#ci-youtube', 'rowchannel');
    a.click('#jb-youtube');
    await a.tick(4);
    assertEqual(a.$('#youtube-url').value, 'rowchannel');
  });

  it('asks for input when the panel box is empty', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.click('#youtube-load');
    await a.tick(1);
    assertIncludes(a.$('#toast').textContent, 'Enter a YouTube channel name');
    assertEqual(a.api().S.channels.youtube, null);
  });
});

describe('app: kick emotes are available without being posted', () => {
  const KICK_EMOTE_PAYLOAD = [
    { id: 'emoji', name: 'Emoji', emotes: [{ id: 1, name: 'kickSmile' }] },
    { id: 'Global', name: 'Global', emotes: [{ id: 2, name: 'kickGlobal' }] },
    { id: 42, slug: 'kickstreamer', emotes: [
      { id: 3, name: 'streamerHype', subscribers_only: true },
      { id: 4, name: 'streamerLove', subscribers_only: true },
    ] },
  ];

  it('fills the emote picker on join, before anyone posts an emote', async () => {
    const a = await boot({ electronAPI: { fetchKickEmotes: async () => KICK_EMOTE_PAYLOAD } });
    a.click('.skip-btn');
    stubKick(a);
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(5);

    // No chat message has arrived at all at this point.
    assertEqual(a.$$('#feed .msg').length, 0);

    a.click('#emote-btn');
    // From the image's alt: the cell carries no title any more, because the
    // hover preview names the emote at a size worth looking at.
    const names = a.$$('#emote-results .emote-grid-item img').map(el => el.getAttribute('alt')).sort();
    assertEqual(names, ['kickGlobal', 'kickSmile', 'streamerHype', 'streamerLove']);
    assertIncludes(a.$('#emote-results').textContent, 'Kick Channel (2)');
    assertIncludes(a.$('#emote-results').textContent, 'Kick Global (1)');
  });

  it('makes subscriber emotes completable by name right away', async () => {
    const a = await boot({ electronAPI: { fetchKickEmotes: async () => KICK_EMOTE_PAYLOAD } });
    a.click('.skip-btn');
    stubKick(a);
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(5);

    a.type('#send-input', ':streamer');
    assertEqual(a.$$('#autocomplete-popup .ac-item').length, 2);
    a.key('#send-input', 'Tab');
    assertEqual(a.$('#send-input').value, 'streamerHype ');
  });

  it('retries once when Kick blocks the first request', async () => {
    let calls = 0;
    const a = await boot({
      electronAPI: {
        fetchKickEmotes: async () => { calls++; return calls === 1 ? null : KICK_EMOTE_PAYLOAD; },
      },
    });
    a.click('.skip-btn');
    stubKick(a);
    a.fetch.route('/kick-emotes', () => a.fetch.json({ error: 'blocked' }, 403));
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.wait(1400);
    assert(calls >= 2, `expected a retry, saw ${calls} attempt(s)`);
    assert(a.api().S.nativeEmotes.kick.kickGlobal, 'the retry should have loaded emotes');
  });

  it('restores global emotes at startup with no channel joined', async () => {
    const first = await boot({ electronAPI: { fetchKickEmotes: async () => KICK_EMOTE_PAYLOAD } });
    first.click('.skip-btn');
    stubKick(first);
    first.type('#ci-kick', 'kickstreamer');
    first.click('#jb-kick');
    await first.tick(5);
    const stored = first.window.localStorage.getItem('kick_emotes_cache_v2');
    assert(stored, 'emotes should have been cached');

    // A fresh launch: nothing joined, no network.
    const b = await boot({ storage: { kick_emotes_cache_v2: stored } });
    b.click('.skip-btn');
    assertEqual(b.api().S.channels.kick, null);
    assert(b.api().S.nativeEmotes.kick.kickGlobal, 'global emotes should be back');
    assert(b.api().S.nativeEmotes.kick.kickSmile, 'emoji should be back');
    assert(!b.api().S.nativeEmotes.kick.streamerHype, 'channel emotes must not leak between channels');

    assert(!b.$('#emote-btn').disabled, 'the picker must be reachable');
    b.click('#emote-btn');
    assertEqual(b.$('#emote-count').textContent, '2');
  });

  it('keeps channel emotes separated per channel in the cache', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const S = a.api().S;
    S.nativeEmotes.kick = {
      kickGlobal: { url: 'https://x/g.png', source: 'Kick Global' },
      aOnly: { url: 'https://x/a.png', source: 'Kick Channel' },
    };
    a.window.eval(`cacheKickEmotes('channel-a')`);
    S.nativeEmotes.kick = {
      kickGlobal: { url: 'https://x/g.png', source: 'Kick Global' },
      bOnly: { url: 'https://x/b.png', source: 'Kick Channel' },
    };
    a.window.eval(`cacheKickEmotes('channel-b')`);

    const cache = JSON.parse(a.window.localStorage.getItem('kick_emotes_cache_v2'));
    assertEqual(Object.keys(cache.global.emotes), ['kickGlobal']);
    assertEqual(Object.keys(cache.channels['channel-a'].emotes), ['aOnly']);
    assertEqual(Object.keys(cache.channels['channel-b'].emotes), ['bOnly']);
  });

  it('does not file passively collected emotes as global', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.fetch.route('/kick-emotes', () => a.fetch.json({ error: 'blocked' }, 403));
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.tick(4);
    const ws = a.ws.byUrl('pusher.com').pop();
    ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await a.tick(2);
    ws.emit(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({ id: 'k3', content: 'hi [emote:900:seenInChat]', sender: { id: 1, username: 'Fan' } }),
    }));
    assertEqual(a.api().S.nativeEmotes.kick.seenInChat.source, 'Kick Channel');
    const cache = JSON.parse(a.window.localStorage.getItem('kick_emotes_cache_v2'));
    assertEqual(cache.global, null);
    assert(cache.channels.kickstreamer.emotes.seenInChat, 'it belongs to this channel only');
  });

  it('warms the cache from the most recent channel when globals expired', async () => {
    let asked = null;
    const a = await boot({
      storage: {
        recent_chat_channels_v1: JSON.stringify({ kick: [{ name: 'lastchannel', lastOpened: Date.now() }] }),
      },
      electronAPI: {
        fetchKickEmotes: async (channel) => { asked = channel; return KICK_EMOTE_PAYLOAD; },
      },
    });
    await a.tick(4);
    assertEqual(asked, 'lastchannel');
    assert(a.api().S.nativeEmotes.kick.kickGlobal, 'globals should be warmed in the background');
  });

  it('says so in the feed when the emote list cannot be loaded', async () => {
    const a = await boot();
    a.click('.skip-btn');
    stubKick(a);
    a.fetch.route('/kick-emotes', () => a.fetch.json({ error: 'blocked' }, 403));
    a.type('#ci-kick', 'kickstreamer');
    a.click('#jb-kick');
    await a.wait(3600);
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'could not load the channel emote list');
  });
});

describe('app: version display', () => {
  it('shows the version from /config in the top bar and settings', async () => {
    const a = await boot({
      config: { twitch: { client_id: 'x' }, kick: { client_id: 'y' }, has_kick: true, version: '9.9.9' },
    });
    await a.tick(2);
    assertEqual(a.$('#app-version').textContent, 'v9.9.9');
    a.click('.skip-btn');
    a.click('#settings-btn');
    assertEqual(a.$('#settings-version').textContent, 'Friendly Chat v9.9.9');
  });

  it('hides the badge when the server does not report a version', async () => {
    const a = await boot({
      config: { twitch: { client_id: 'x' }, kick: { client_id: 'y' }, has_kick: true },
    });
    await a.tick(2);
    assertEqual(a.$('#app-version').textContent, '');
  });
});

describe('app: update notification', () => {
  const UPDATE = {
    available: true,
    currentVersion: '1.4.0',
    latestVersion: '1.5.0',
    name: 'v1.5.0',
    notes: 'Faster emotes.\nBetter YouTube.',
    releaseUrl: 'https://github.com/JRBlaze/FriendlyChat/releases/tag/v1.5.0',
    asset: { name: 'Setup.exe', url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/Setup.exe', size: 2048 },
  };

  function electronUpdateAPI(overrides = {}) {
    return {
      getUpdateEnvironment: async () => ({ platform: 'win32', arch: 'x64', version: '1.4.0' }),
      downloadUpdate: async () => ({ path: '/tmp/friendly-chat-updates/Setup.exe', size: 2048 }),
      installUpdate: async () => ({ opened: 'installer', quitting: true }),
      onUpdateProgress: () => () => {},
      ...overrides,
    };
  }

  it('shows a banner when a newer release exists', async () => {
    const a = await boot({
      config: { twitch: { client_id: 'x' }, kick: { client_id: 'y' }, version: '1.4.0' },
      routes: [['/update-check', () => UPDATE]],
      electronAPI: electronUpdateAPI(),
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    assert(!a.$('#update-banner').classList.contains('hidden'), 'banner should be visible');
    assertIncludes(a.$('#update-title').textContent, 'Friendly Chat 1.5.0');
    assertIncludes(a.$('#update-title').textContent, 'you have 1.4.0');
    assertEqual(a.$('#update-action').textContent, 'Download & install');
  });

  it('stays quiet when the app is current', async () => {
    const a = await boot({
      routes: [['/update-check', () => ({ available: false, currentVersion: '1.4.0', latestVersion: '1.4.0' })]],
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    assert(a.$('#update-banner').classList.contains('hidden'));
  });

  it('sends the running version, platform and arch to the server', async () => {
    const a = await boot({
      config: { twitch: { client_id: 'x' }, kick: { client_id: 'y' }, version: '1.4.0' },
      routes: [['/update-check', () => ({ available: false })]],
      electronAPI: electronUpdateAPI(),
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    const call = a.fetch.callsTo('/update-check')[0];
    assertIncludes(call.url, 'current=1.4.0');
    assertIncludes(call.url, 'platform=win32');
    assertIncludes(call.url, 'arch=x64');
  });

  it('shows release notes on demand', async () => {
    const a = await boot({ routes: [['/update-check', () => UPDATE]], electronAPI: electronUpdateAPI() });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    assert(!a.$('#update-notes').classList.contains('open'));
    a.click('#update-notes-toggle');
    assert(a.$('#update-notes').classList.contains('open'));
    assertIncludes(a.$('#update-notes').textContent, 'Faster emotes.');
    assertEqual(a.$('#update-notes-toggle').textContent, 'Hide notes');
  });

  it('downloads and hands the installer to the OS', async () => {
    let downloadedAsset = null;
    let installedPath = '';
    const a = await boot({
      routes: [['/update-check', () => UPDATE]],
      electronAPI: electronUpdateAPI({
        downloadUpdate: async (asset) => { downloadedAsset = asset; return { path: '/tmp/friendly-chat-updates/Setup.exe', size: 2048 }; },
        installUpdate: async (p) => { installedPath = p; return { opened: 'installer', quitting: true }; },
      }),
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    await a.api().startUpdateDownload();

    assertEqual(downloadedAsset.url, UPDATE.asset.url);
    assertEqual(installedPath, '/tmp/friendly-chat-updates/Setup.exe');
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'Installer started');
  });

  it('reports a failed download instead of hanging', async () => {
    const a = await boot({
      routes: [['/update-check', () => UPDATE]],
      electronAPI: electronUpdateAPI({ downloadUpdate: async () => ({ error: 'network died' }) }),
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    await a.api().startUpdateDownload();
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'Update download failed: network died');
    assertEqual(a.$('#update-action').textContent, 'Retry download');
    assertEqual(a.$('#update-action').disabled, false);
  });

  it('offers the release page when there is no build for this platform', async () => {
    let openedUrl = '';
    const a = await boot({
      routes: [['/update-check', () => ({ ...UPDATE, asset: null, reason: 'no-asset-for-platform' })]],
      electronAPI: electronUpdateAPI(),
    });
    a.click('.skip-btn');
    a.window.open = (url) => { openedUrl = url; return null; };
    await a.api().checkForUpdate();
    assertEqual(a.$('#update-action').textContent, 'Open release page');
    await a.api().startUpdateDownload();
    assertIncludes(openedUrl, '/releases/tag/v1.5.0');
  });

  it('links to the release page in a plain browser', async () => {
    let openedUrl = '';
    const a = await boot({ routes: [['/update-check', () => UPDATE]] });
    a.click('.skip-btn');
    a.window.open = (url) => { openedUrl = url; return null; };
    await a.api().checkForUpdate();
    assertEqual(a.$('#update-action').textContent, 'Open release page');
    await a.api().startUpdateDownload();
    assertIncludes(openedUrl, '/releases/tag/v1.5.0');
  });

  it('remembers a skipped version and stops nagging', async () => {
    const a = await boot({ routes: [['/update-check', () => UPDATE]], electronAPI: electronUpdateAPI() });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    a.click('#update-skip');
    assert(a.$('#update-banner').classList.contains('hidden'));
    assertEqual(a.api().settings.skippedVersion, '1.5.0');

    // A later automatic check must not bring it back.
    await a.api().checkForUpdate();
    assert(a.$('#update-banner').classList.contains('hidden'), 'a skipped version must stay hidden');
  });

  it('an explicit check overrides a skipped version', async () => {
    const a = await boot({
      storage: { friendly_chat_settings_v1: JSON.stringify({ skippedVersion: '1.5.0' }) },
      routes: [['/update-check', () => UPDATE]],
      electronAPI: electronUpdateAPI(),
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    assert(a.$('#update-banner').classList.contains('hidden'));
    await a.api().checkForUpdate({ manual: true });
    assert(!a.$('#update-banner').classList.contains('hidden'));
  });

  it('Later hides the banner without skipping the version', async () => {
    const a = await boot({ routes: [['/update-check', () => UPDATE]], electronAPI: electronUpdateAPI() });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    a.click('#update-later');
    assert(a.$('#update-banner').classList.contains('hidden'));
    assertEqual(a.api().settings.skippedVersion, '');
  });

  it('surfaces a check failure in settings without breaking the app', async () => {
    const a = await boot({
      routes: [['/update-check', () => a.fetch.json({ error: 'GitHub rate limit reached' }, 502)]],
    });
    a.click('.skip-btn');
    const result = await a.api().checkForUpdate({ manual: true });
    assertIncludes(result.error, 'rate limit');
    assert(a.$('#update-banner').classList.contains('hidden'));
    assertEqual(a.consoleErrors.length, 0);
  });

  it('honours the auto-check toggle', async () => {
    const a = await boot({ routes: [['/update-check', () => UPDATE]] });
    a.click('.skip-btn');
    a.click('#settings-btn');
    a.change('#set-auto-update', false);
    assertEqual(a.api().settings.autoUpdateCheck, false);
    assertEqual(JSON.parse(a.window.localStorage.getItem('friendly_chat_settings_v1')).autoUpdateCheck, false);
  });

  it('clears a skipped version from settings', async () => {
    const a = await boot({
      storage: { friendly_chat_settings_v1: JSON.stringify({ skippedVersion: '1.5.0' }) },
      routes: [['/update-check', () => UPDATE]],
      electronAPI: electronUpdateAPI(),
    });
    a.click('.skip-btn');
    await a.api().checkForUpdate();
    a.click('#settings-btn');
    a.click('#set-clear-skip');
    assertEqual(a.api().settings.skippedVersion, '');
    assert(!a.$('#update-banner').classList.contains('hidden'), 'the banner should come back');
  });
});

// The CTCP byte `/me` arrives wrapped in, built rather than written literally so
// the file stays plain ASCII.
const CTCP_BYTE = String.fromCharCode(1);

async function joinKick(a, channel = 'kickstreamer') {
  stubKick(a);
  a.type('#ci-kick', channel);
  a.click('#jb-kick');
  await a.tick(3);
  const ws = a.ws.byUrl('pusher.com').pop();
  ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
  await a.tick(2);
  return ws;
}

describe('app: twitch message quality', () => {
  it('renders /me as an action rather than printing the wrapper', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit(`@display-name=Bob :b!b@b.tmi.twitch.tv PRIVMSG #somestreamer :${CTCP_BYTE}ACTION waves${CTCP_BYTE}\r\n`);
    a.flush();
    const row = a.$('#feed .msg[data-platform="twitch"]');
    assertEqual(row.querySelector('.m-body').textContent, 'waves');
    assertIncludes(row.className, 'action');
    assertEqual(row.querySelector('.m-colon'), null);
  });

  it('keeps emote positions right inside an action', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    // The positions Twitch sends are counted from the text inside the wrapper,
    // so unwrapping late would leave every one of them eight characters out.
    ws.emit(`@display-name=Bob;emotes=25:0-4 :b!b@b.tmi.twitch.tv PRIVMSG #somestreamer :${CTCP_BYTE}ACTION Kappa waves${CTCP_BYTE}\r\n`);
    a.flush();
    assertEqual(a.$('#feed .msg .chat-emote').getAttribute('alt'), 'Kappa');
  });

  it('marks a first message on twitch\'s own flag, and only then', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@first-msg=1;display-name=New :n!n@n.tmi.twitch.tv PRIVMSG #somestreamer :hi\r\n');
    ws.emit('@first-msg=0;display-name=Old :o!o@o.tmi.twitch.tv PRIVMSG #somestreamer :hi\r\n');
    a.flush();
    const rows = a.$$('#feed .msg[data-platform="twitch"]');
    assertIncludes(rows[0].className, 'first-msg');
    assertEqual(rows[0].querySelector('.first-tag').textContent, 'FIRST MESSAGE');
    assertNotIncludes(rows[1].className, 'first-msg');
  });

  it('draws the message a reply is answering above it', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@display-name=Bob;reply-parent-display-name=Alice;reply-parent-msg-id=p1;'
      + 'reply-parent-msg-body=what\\stime\\sis\\sit '
      + ':b!b@b.tmi.twitch.tv PRIVMSG #somestreamer :in a minute\r\n');
    a.flush();
    const row = a.$('#feed .msg[data-platform="twitch"]');
    assertEqual(row.querySelector('.reply-name').textContent, '@Alice');
    assertIncludes(row.querySelector('.reply-text').textContent, 'what time is it');
  });

  it('gives a name colour one readable value per theme', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@display-name=Bob;color=#0000AA :b!b@b.tmi.twitch.tv PRIVMSG #somestreamer :hello\r\n');
    a.flush();
    const style = a.$('#feed .msg .m-author').getAttribute('style');
    assertIncludes(style, '--author-dark:');
    assertIncludes(style, '--author-light:');
  });

  it('draws the resub message with its emotes and the summary without', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinTwitch(a);
    ws.emit('@msg-id=resub;display-name=Alice;msg-param-cumulative-months=3;emotes=25:0-4 '
      + ':tmi.twitch.tv USERNOTICE #somestreamer :Kappa is great\r\n');
    a.flush();
    const row = a.$('#feed .sys-msg.event[data-platform="twitch"]');
    assertIncludes(row.textContent, 'Alice resubscribed (3 months).');
    assertEqual(row.querySelector('.sys-said .chat-emote').getAttribute('alt'), 'Kappa');
  });
});

describe('app: kick message quality', () => {
  it('draws the message a kick reply is answering above it', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinKick(a);
    ws.emit(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({
        id: 'k2',
        content: 'sure',
        sender: { id: 3, username: 'KickFan', identity: { color: '#00AA00', badges: [] } },
        metadata: {
          original_sender: { username: 'Alice' },
          original_message: { id: 'k1', content: 'ready?' },
        },
      }),
    }));
    a.flush();
    const row = a.$('#feed .msg[data-platform="kick"]');
    assertEqual(row.querySelector('.reply-name').textContent, '@Alice');
    assertIncludes(row.querySelector('.reply-text').textContent, 'ready?');
    assertIncludes(row.querySelector('.m-author').getAttribute('style'), '--author-dark:');
  });

  it('says a ban in words as well as striking the messages through', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinKick(a);
    ws.emit(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({ id: 'k9', content: 'rude', sender: { id: 5, username: 'Rude' } }),
    }));
    ws.emit(JSON.stringify({
      event: 'App\\Events\\UserBannedEvent',
      data: JSON.stringify({ user: { username: 'Rude' } }),
    }));
    a.flush();
    assertIncludes(a.$('#feed .msg[data-platform="kick"]').className, 'deleted');
    assertIncludes(a.$('#feed .sys-msg.event[data-platform="kick"]').textContent, 'Rude was banned.');
  });

  it('reads a timeout out of the expiry the ban event carries', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinKick(a);
    ws.emit(JSON.stringify({
      event: 'App\\Events\\UserBannedEvent',
      data: JSON.stringify({
        user: { username: 'Rude' },
        expires_at: new Date(Date.now() + 300 * 1000).toISOString(),
      }),
    }));
    a.flush();
    assertIncludes(a.$('#feed .sys-msg.event[data-platform="kick"]').textContent,
      'Rude was timed out for 5m.');
  });

  it('keeps housekeeping chatter out of the feed', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const ws = await joinKick(a);
    const before = a.$$('#feed .sys-msg.event').length;
    ws.emit(JSON.stringify({ event: 'App\\Events\\ChatroomUpdatedEvent', data: '{}' }));
    ws.emit(JSON.stringify({ event: 'App\\Events\\StreamerIsLiveStatisticEvent', data: '{}' }));
    a.flush();
    assertEqual(a.$$('#feed .sys-msg.event').length, before);
  });
});
