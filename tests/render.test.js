const { launchApp } = require('./helpers/harness');

let app;

async function boot(options) {
  if (app) app.close();
  app = await launchApp(options);
  return app;
}

function body(app, index = 0) {
  app.flush();
  return app.$$('#feed .msg .m-body')[index]?.innerHTML || '';
}

describe('render: escaping and links', () => {
  it('escapes HTML in message bodies and author names', async () => {
    const a = await boot();
    const api = a.api();
    api.addMsg('twitch', '<img src=x onerror=alert(1)>', '<script>alert(2)</script> & "quotes"', {});
    a.flush();
    const msg = a.$('#feed .msg');
    // Nothing hostile may become a real node: the payload survives only as text.
    assertEqual(msg.querySelectorAll('img, script, iframe').length, 0);
    assertIncludes(msg.querySelector('.m-body').textContent, '<script>alert(2)</script>');
    assertIncludes(msg.querySelector('.m-body').textContent, '& "quotes"');
    assertEqual(msg.querySelector('.m-author').textContent, '<img src=x onerror=alert(1)>');
  });

  it('does not double-escape ampersands inside links', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'look https://example.com/a?b=1&c=2 ok', {});
    const html = body(a);
    assertIncludes(html, 'href="https://example.com/a?b=1&amp;c=2"');
    assertNotIncludes(html, '&amp;amp;');
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/a?b=1&c=2');
  });

  it('linkifies kick messages without mangling the query string', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'see https://kick.com/x?a=1&b=2', {});
    const html = body(a);
    assertNotIncludes(html, '&amp;amp;');
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://kick.com/x?a=1&b=2');
  });

  it('keeps trailing punctuation out of the link', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'go to https://example.com/page.', {});
    a.flush();
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/page');
    assertIncludes(a.$('#feed .m-body').textContent, 'https://example.com/page.');
  });

  it('does not turn a javascript: string into a link', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'javascript:alert(1)', {});
    assertEqual(a.$$('#feed .chat-link').length, 0);
  });
});

describe('render: twitch emotes', () => {
  it('replaces native emote ranges using codepoint positions', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'Kappa hello', {
      emoteMap: { 0: { id: '25', end: 4 } },
    });
    const html = body(a);
    assertIncludes(html, 'emoticons/v2/25/default/dark');
    assertIncludes(html, 'alt="Kappa"');
    assertIncludes(html, 'hello');
  });

  it('keeps emote positions correct after multi-byte characters', async () => {
    const a = await boot();
    // "😀 Kappa" — Kappa starts at codepoint index 2, byte index 4.
    a.api().addMsg('twitch', 'user', '😀 Kappa', {
      emoteMap: { 2: { id: '25', end: 6 } },
    });
    const html = body(a);
    assertIncludes(html, 'alt="Kappa"');
    assertIncludes(html, '😀');
  });

  it('renders 7TV, BTTV and FFZ emotes from the third-party store', async () => {
    const a = await boot();
    const S = a.api().S;
    S.thirdPartyEmotes.twitch = {
      catJAM: { url: 'https://cdn.7tv.app/catjam.webp', source: '7TV' },
      monkaS: { url: 'https://cdn.betterttv.net/emote/1/2x', source: 'BTTV' },
      ZreknarF: { url: 'https://cdn.frankerfacez.com/2', source: 'FFZ' },
    };
    a.api().addMsg('twitch', 'user', 'catJAM monkaS ZreknarF plain', {});
    const html = body(a);
    assertIncludes(html, 'cdn.7tv.app/catjam.webp');
    assertIncludes(html, 'cdn.betterttv.net/emote/1/2x');
    assertIncludes(html, 'cdn.frankerfacez.com/2');
    assertIncludes(html, 'plain');
    assertEqual(a.$$('#feed .chat-emote').length, 3);
  });

  it('does not replace text inside a link with an emote', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { example: { url: 'https://x/e.png', source: '7TV' } };
    a.api().addMsg('twitch', 'user', 'https://example.com/example', {});
    const html = body(a);
    assertEqual(a.$$('#feed .chat-emote').length, 0);
    assertIncludes(html, 'href="https://example.com/example"');
  });

  it('matches emotes only as whole words', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { pog: { url: 'https://x/pog.png', source: '7TV' } };
    a.api().addMsg('twitch', 'user', 'pogchamp pog', {});
    a.flush();
    assertEqual(a.$$('#feed .chat-emote').length, 1);
    assertIncludes(a.$('#feed .m-body').textContent, 'pogchamp');
  });

  it('handles emote names containing HTML-special characters', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { '<3': { url: 'https://x/heart.png', source: 'BTTV' } };
    a.api().addMsg('twitch', 'user', 'love <3 you', {});
    a.flush();
    const img = a.$('#feed .chat-emote');
    assertEqual(img.getAttribute('src'), 'https://x/heart.png');
    assertEqual(img.getAttribute('alt'), '<3');
  });
});

describe('render: kick emotes', () => {
  it('renders inline [emote:id:name] tokens', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'hey [emote:1234:kickHi] there', {});
    const html = body(a);
    assertIncludes(html, 'files.kick.com/emotes/1234/fullsize');
    assertIncludes(html, 'alt="kickHi"');
    assertIncludes(html, 'there');
  });

  it('renders emotes supplied as history metadata', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'wow kickLove', {
      emotes: [{ id: 55, name: 'kickLove' }],
    });
    assertIncludes(body(a), 'files.kick.com/emotes/55/fullsize');
  });

  it('parses kick nested emote-set payloads (global, emoji and channel sets)', async () => {
    const a = await boot();
    const store = a.api().parseKickEmotePayload([
      { id: 'emoji', name: 'Emoji', emotes: [{ id: 1, name: 'smile' }] },
      { id: 'Global', name: 'Global', emotes: [{ id: 2, name: 'kickGlobal' }] },
      { id: 42, user_id: 7, slug: 'streamer', emotes: [{ id: 3, name: 'streamerLove', subscribers_only: true }] },
    ]);
    assertEqual(Object.keys(store).sort(), ['kickGlobal', 'smile', 'streamerLove']);
    assertEqual(store.kickGlobal.source, 'Kick Global');
    assertEqual(store.smile.source, 'Kick Emoji');
    assertEqual(store.streamerLove.source, 'Kick Channel');
    assertEqual(store.streamerLove.url, 'https://files.kick.com/emotes/3/fullsize');
  });

  it('still accepts a flat emote list', async () => {
    const a = await boot();
    const store = a.api().parseKickEmotePayload([{ id: 9, name: 'flatEmote' }]);
    assertEqual(store.flatEmote.url, 'https://files.kick.com/emotes/9/fullsize');
  });

  it('ignores junk payloads instead of throwing', async () => {
    const a = await boot();
    assertEqual(a.api().parseKickEmotePayload(null), {});
    assertEqual(a.api().parseKickEmotePayload({ error: 'blocked' }), {});
    assertEqual(a.api().parseKickEmotePayload([{ emotes: [{ id: 'not-numeric', name: 'x' }] }]), {});
  });
});

describe('render: youtube messages', () => {
  it('renders text, custom emoji and links from run arrays', async () => {
    const a = await boot();
    a.api().addMsg('youtube', 'Viewer', 'hello :_cozy: link', {
      runs: [
        { type: 'text', text: 'hello ' },
        { type: 'emoji', url: 'https://yt3.ggpht.com/cozy.png', alt: ':_cozy:' },
        { type: 'text', text: ' ' },
        { type: 'link', url: 'https://example.com/?a=1&b=2', text: 'https://example.com/?a=1&b=2' },
      ],
    });
    const html = body(a);
    assertIncludes(html, 'yt3.ggpht.com/cozy.png');
    assertIncludes(html, 'youtube-emote');
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/?a=1&b=2');
  });

  it('shows super chat amounts', async () => {
    const a = await boot();
    a.api().addMsg('youtube', 'Spender', 'thanks', { runs: [{ type: 'text', text: 'thanks' }], superChat: '$5.00' });
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'superchat');
    assertEqual(a.$('#feed .superchat-amount').textContent, '$5.00');
  });

  it('escapes a hostile YouTube display name', async () => {
    const a = await boot();
    a.api().addMsg('youtube', `'); alert(1); //`, 'hi', { runs: [{ type: 'text', text: 'hi' }] });
    a.flush();
    const author = a.$('#feed .m-author');
    assertEqual(author.dataset.user, `'); alert(1); //`);
    assertNotIncludes(a.$('#feed .msg').innerHTML, 'alert(1)</span>');
  });
});

describe('render: mentions', () => {
  it('highlights a whole-word mention and not a substring', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob how are you', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
    assertEqual(a.$('#feed .mention-self').textContent, '@bob');
  });

  it('ignores a name embedded in a longer word', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'bobcat sighting', {});
    a.flush();
    assertNotIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('matches a bare nickname surrounded by punctuation', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hi, bob!', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('never highlights your own messages', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'bob', 'talking about bob again', {});
    a.flush();
    assertNotIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('does not corrupt markup when the name also appears in an emote url', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'cdn';
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://cdn.7tv.app/catjam.webp', source: '7TV' } };
    a.api().addMsg('twitch', 'someone', 'catJAM cdn', {});
    a.flush();
    const img = a.$('#feed .chat-emote');
    assertEqual(img.getAttribute('src'), 'https://cdn.7tv.app/catjam.webp');
    assertEqual(a.$('#feed .mention-self').textContent, 'cdn');
  });

  it('uses the extra nicknames from settings', async () => {
    const a = await boot();
    a.api().settings.extraNicknames = 'CoolGuy, other';
    a.api().addMsg('twitch', 'someone', 'yo coolguy', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('handles regex characters in a nickname without throwing', async () => {
    const a = await boot();
    a.api().settings.extraNicknames = 'a.b(c)';
    a.api().addMsg('twitch', 'someone', 'hello a.b(c) there', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });
});

describe('render: system and event rows', () => {
  it('renders system rows with a SYSTEM tag, not as a chat message', async () => {
    const a = await boot();
    a.api().addSys('Connected to Twitch: someone');
    a.flush();
    const row = a.$('#feed .sys-msg');
    assert(row, 'expected a system row');
    assertEqual(row.querySelector('.sys-tag').textContent, 'SYSTEM');
    assertEqual(a.$$('#feed .msg').length, 0, 'system rows must not be chat messages');
    assertEqual(row.querySelector('.m-author'), null);
  });

  it('flags errors so they stand out', async () => {
    const a = await boot();
    a.api().addSys('Kick: could not load channel');
    a.flush();
    assertIncludes(a.$('#feed .sys-msg').className, 'error');
  });

  it('renders platform events as EVENT rows carrying the platform', async () => {
    const a = await boot();
    a.api().addEvent('twitch', 'someone subscribed.');
    a.flush();
    const row = a.$('#feed .sys-msg.event');
    assertEqual(row.dataset.platform, 'twitch');
    assertEqual(row.querySelector('.sys-tag').textContent, 'EVENT');
    assertIncludes(row.textContent, 'someone subscribed.');
  });

  it('escapes system text', async () => {
    const a = await boot();
    a.api().addSys('<script>alert(1)</script>');
    a.flush();
    assertNotIncludes(a.$('#feed .sys-msg').innerHTML, '<script>');
  });
});

describe('render: IRC parsing', () => {
  it('parses tags, prefix, command and trailing parameters', async () => {
    const a = await boot();
    const line = '@badges=moderator/1;display-name=Bob;id=abc :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hello world';
    const parsed = a.api().parseIrcLine(line);
    assertEqual(parsed.command, 'PRIVMSG');
    assertEqual(parsed.params, ['#chan', 'hello world']);
    assertEqual(parsed.tags['display-name'], 'Bob');
  });

  it('unescapes IRCv3 tag values', async () => {
    const a = await boot();
    const parsed = a.api().parseIrcLine('@system-msg=Bob\\ssubscribed\\:\\syay :tmi.twitch.tv USERNOTICE #chan');
    assertEqual(parsed.tags['system-msg'], 'Bob subscribed; yay');
  });

  it('does not treat a message mentioning USERSTATE as a USERSTATE line', async () => {
    const a = await boot();
    const parsed = a.api().parseIrcLine(':bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :what is USERSTATE anyway');
    assertEqual(parsed.command, 'PRIVMSG');
    assertEqual(parsed.params[1], 'what is USERSTATE anyway');
  });

  it('handles lines without tags or prefix', async () => {
    const a = await boot();
    assertEqual(a.api().parseIrcLine('PING :tmi.twitch.tv').command, 'PING');
    assertEqual(a.api().parseIrcLine('').command, '');
  });
});

process.on('exit', () => { if (app) app.close(); });

describe('render: link edge cases', () => {
  it('links a URL wrapped in brackets', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'see (https://example.com/page) for more', {});
    a.flush();
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/page');
    assertIncludes(a.$('#feed .m-body').textContent, '(https://example.com/page)');
  });

  it('keeps multiple links in one message separate', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'https://a.example https://b.example', {});
    a.flush();
    const hrefs = a.$$('#feed .chat-link').map(el => el.getAttribute('href'));
    assertEqual(hrefs, ['https://a.example', 'https://b.example']);
  });

  it('links a bare domain, which is what people actually paste', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'go to example.com now', {});
    a.flush();
    const link = a.$('#feed .chat-link');
    // The scheme people left off. http would be a downgrade nobody asked for.
    assertEqual(link.getAttribute('href'), 'https://example.com');
    // What is shown is exactly what was typed, so a row can never display one
    // address while pointing at another.
    assertEqual(link.textContent, 'example.com');
  });

  it('keeps the path on a bare link and the sentence punctuation off it', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'watch (kick.com/somechannel).', {});
    a.flush();
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://kick.com/somechannel');
    assertIncludes(a.$('#feed .m-body').textContent, '(kick.com/somechannel).');
  });

  it('does not turn filenames into links', async () => {
    const a = await boot();
    // "any dotted word" would point every one of these at nothing.
    a.api().addMsg('twitch', 'user', 'see node.js and README.md and run.sh', {});
    a.flush();
    assertEqual(a.$$('#feed .chat-link').length, 0);
  });

  it('does not link a dotted word followed by something that is not a path', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'example.com@notalink', {});
    a.flush();
    assertEqual(a.$$('#feed .chat-link').length, 0);
  });
});

describe('render: author colours stay readable', () => {
  it('emits a readable colour for each theme and keeps the hue', async () => {
    const a = await boot();
    // A dark blue plenty of people pick, which lands around 2:1 on a dark feed.
    a.api().addMsg('twitch', 'user', 'hello', { color: '#0000AA' });
    a.flush();
    const style = a.$('#feed .m-author').getAttribute('style');
    const dark = /--author-dark:\s*(#[0-9a-f]{6})/i.exec(style)[1];
    const light = /--author-light:\s*(#[0-9a-f]{6})/i.exec(style)[1];
    // Lifted on the dark feed, left alone or pushed down on the light one.
    assert(dark !== '#0000aa', 'a colour that fails on the dark feed must be lifted');
    assert(dark.toLowerCase() !== light.toLowerCase(), 'each theme gets its own value');
    // Blue stays blue: only the lightness moves.
    const [, dr, dg, db] = /#(..)(..)(..)/.exec(dark).map((v, i) => (i ? parseInt(v, 16) : v));
    assert(db > dr && db > dg, `hue was not preserved: ${dark}`);
  });

  it('leaves a row with no colour on the platform tint', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'hello', {});
    a.flush();
    assertEqual(a.$('#feed .m-author').getAttribute('style'), null);
  });

  it('ignores anything that is not a six-digit hex colour', async () => {
    const a = await boot();
    const api = a.api();
    ['', 'red', '#fff', 'javascript:alert(1)', '#00ff00" onload="x'].forEach(value => {
      assertEqual(api.authorColorStyle(value), '', `accepted ${JSON.stringify(value)}`);
    });
  });
});

describe('render: mentions of other people', () => {
  it('draws somebody else in the colour this feed has seen them use', async () => {
    const a = await boot();
    const api = a.api();
    api.addMsg('twitch', 'Alice', 'hi', { color: '#00AA00' });
    api.addMsg('twitch', 'Bob', '@Alice hello', {});
    a.flush();
    const mention = a.$$('#feed .msg')[1].querySelector('.mention-user');
    assertEqual(mention.textContent, '@Alice');
    assertIncludes(mention.getAttribute('style'), '--author-dark:');
  });

  it('falls back to the platform tint for a name nobody here has used', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'Bob', '@Stranger hello', {});
    a.flush();
    const mention = a.$('#feed .mention-user');
    assertEqual(mention.className, 'mention-user kick');
    assertEqual(mention.getAttribute('style'), null);
  });

  it('leaves the viewer\'s own name as the mention highlight, not a user chip', async () => {
    const a = await boot();
    a.api().settings.extraNicknames = 'me';
    a.api().addMsg('twitch', 'Bob', '@me look', {});
    a.flush();
    assertEqual(a.$$('#feed .mention-user').length, 0);
    assert(a.$('#feed .msg').classList.contains('mention-highlight'), 'row should be highlighted');
  });

  it('never unlearns a colour an earlier message established', async () => {
    const a = await boot();
    const api = a.api();
    api.rememberChatter('twitch', 'Alice', '#00AA00');
    // A later message without a colour must not blank it, or an @mention of
    // them would flicker between the two.
    api.rememberChatter('twitch', 'Alice', '');
    assertEqual(api.chatterColor('twitch', 'alice'), '#00AA00');
  });
});

// The CTCP byte `/me` arrives wrapped in. Built rather than written literally so
// the file stays plain ASCII.
const CTCP = String.fromCharCode(1);

describe('render: /me actions', () => {
  it('unwraps the CTCP wrapper instead of printing it', async () => {
    const a = await boot();
    const api = a.api();
    assertEqual(api.parseIrcAction(`${CTCP}ACTION waves${CTCP}`), { action: true, text: 'waves' });
    // Every client sends the closing byte, but a line truncated without it is
    // still an action rather than a message about one.
    assertEqual(api.parseIrcAction(`${CTCP}ACTION waves`), { action: true, text: 'waves' });
    assertEqual(api.parseIrcAction('just talking'), { action: false, text: 'just talking' });
  });

  it('drops the colon and paints the line in the sender colour', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'waves', { action: true, color: '#00AA00' });
    a.flush();
    const row = a.$('#feed .msg');
    assertIncludes(row.className, 'action');
    assertEqual(row.querySelector('.m-colon'), null);
    assertIncludes(row.querySelector('.m-body').getAttribute('style'), '--author-dark:');
  });
});

describe('render: reply context', () => {
  it('reads the parent out of the twitch reply tags', async () => {
    const a = await boot();
    const reply = a.api().twitchReplyContext({
      'reply-parent-display-name': 'Alice',
      'reply-parent-user-login': 'alice',
      'reply-parent-msg-body': 'what time is it',
      'reply-parent-msg-id': 'abc123',
    });
    assertEqual(reply.name, 'Alice');
    assertEqual(reply.text, 'what time is it');
    assertEqual(reply.messageId, 'abc123');
    assertEqual(a.api().twitchReplyContext({}), null);
  });

  it('unwraps a parent that was itself an action', async () => {
    const a = await boot();
    const reply = a.api().twitchReplyContext({
      'reply-parent-display-name': 'Alice',
      'reply-parent-msg-body': `${CTCP}ACTION waves${CTCP}`,
    });
    assertEqual(reply.text, 'waves');
  });

  it('reads the parent out of kick metadata', async () => {
    const a = await boot();
    const reply = a.api().kickReplyContext({
      metadata: {
        original_sender: { username: 'Alice' },
        original_message: { id: 'm1', content: 'what time is it' },
      },
    });
    assertEqual(reply, { name: 'Alice', text: 'what time is it', messageId: 'm1' });
    assertEqual(a.api().kickReplyContext(null), null);
    assertEqual(a.api().kickReplyContext({ metadata: {} }), null);
  });

  it('draws the quoted original above the reply, emotes and all', async () => {
    const a = await boot();
    const api = a.api();
    api.S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/catjam.webp', source: '7TV' } };
    api.addMsg('twitch', 'Bob', 'in a minute', {
      reply: { name: 'Alice', text: 'ready catJAM', messageId: 'abc' },
    });
    a.flush();
    const row = a.$('#feed .msg');
    assertIncludes(row.className, 'has-reply');
    assertEqual(row.querySelector('.reply-name').textContent, '@Alice');
    assertEqual(row.querySelector('.reply-context .chat-emote').getAttribute('alt'), 'catJAM');
    // Kept so a reply can be threaded onto it later.
    assertEqual(row.querySelector('.m-author').dataset.replyId, 'abc');
  });

  it('says so when the platform sent no parent text', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'Bob', 'sure', { reply: { name: 'Alice', text: '' } });
    a.flush();
    assertEqual(a.$('#feed .reply-gone').textContent, 'message unavailable');
  });

  it('escapes a hostile display name in the quoted line', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'Bob', 'ok', {
      reply: { name: '<img src=x onerror=alert(1)>', text: '<script>alert(2)</script>' },
    });
    a.flush();
    const row = a.$('#feed .msg');
    assertEqual(row.querySelectorAll('script, iframe').length, 0);
    assertEqual(row.querySelectorAll('.reply-context img').length, 0);
  });
});

describe('render: first messages', () => {
  it('marks a first message on the platform flag alone', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'newcomer', 'hi', { firstMessage: true });
    a.flush();
    const row = a.$('#feed .msg');
    assertIncludes(row.className, 'first-msg');
    assertEqual(row.querySelector('.first-tag').textContent, 'FIRST MESSAGE');
  });

  it('leaves an ordinary message unmarked', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'regular', 'hi', {});
    a.flush();
    assertNotIncludes(a.$('#feed .msg').className, 'first-msg');
    assertEqual(a.$('#feed .first-tag'), null);
  });
});

describe('render: events carry their emotes', () => {
  it('draws the viewer half of an event with emotes and leaves the summary plain', async () => {
    const a = await boot();
    const api = a.api();
    api.S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/catjam.webp', source: '7TV' } };
    // The summary names somebody whose display name spells an emote — a name,
    // not a picture — while the message under the resub is theirs and is drawn
    // as they typed it.
    api.addEvent('twitch', 'catJAM resubscribed (3 months).', { body: 'thanks catJAM' });
    a.flush();
    const row = a.$('#feed .sys-msg.event');
    assertEqual(row.querySelectorAll('.sys-said .chat-emote').length, 1);
    assertEqual(row.querySelectorAll('.chat-emote').length, 1);
    assertIncludes(row.textContent, 'catJAM resubscribed (3 months).');
  });

  it('links an address named in a system row', async () => {
    const a = await boot();
    a.api().addSys('Twitch: open https://twitch.tv/settings to fix this');
    a.flush();
    assertEqual(a.$('#feed .sys-msg .chat-link').getAttribute('href'), 'https://twitch.tv/settings');
  });

  it('still escapes hostile text in a system row', async () => {
    const a = await boot();
    a.api().addSys('<img src=x onerror=alert(1)>');
    a.flush();
    const row = a.$('#feed .sys-msg');
    assertEqual(row.querySelectorAll('img, script').length, 0);
    assertIncludes(row.textContent, '<img src=x onerror=alert(1)>');
  });
});

describe('render: twitch emote map hardening', () => {
  it('drops a range that points backwards', async () => {
    const a = await boot();
    assertEqual(a.api().parseTwitchEmoteMap('25:5-1'), null);
    assertEqual(a.api().parseTwitchEmoteMap('25:-3--1'), null);
  });

  it('renders a message carrying a backwards range instead of hanging', async () => {
    const a = await boot();
    // Hand-built rather than parsed, so the tokenizer's own guard is what is
    // under test: without it the cursor is sent back and the loop never ends.
    const out = a.api().renderMessageBody('twitch', 'hello there', {
      emoteMap: { 6: { id: '25', end: 2 } },
    });
    assertEqual(out.html, 'hello there');
  });
});

describe('render: badges say what the role is', () => {
  it('labels a known role when the badge images have not arrived', async () => {
    const a = await boot();
    const html = a.api().renderTwitchBadges('moderator/1,subscriber/12');
    assertIncludes(html, '>MOD<');
    assertIncludes(html, '>SUB<');
  });

  it('drops decoration rather than dumping a raw set id beside the name', async () => {
    const a = await boot();
    assertEqual(a.api().renderTwitchBadges('moments/1,game-developer/1'), '');
  });

  it('prefers the badge title once the images are loaded', async () => {
    const a = await boot();
    const api = a.api();
    api.S.twitchBadges.global = {
      subscriber: { 12: { image_url_1x: 'https://x/sub.png', title: '12-Month Subscriber' } },
    };
    assertIncludes(api.renderTwitchBadges('subscriber/12'), 'title="12-Month Subscriber"');
  });
});

describe('render: emote previews', () => {
  it('asks each provider for its largest size', async () => {
    const a = await boot();
    const bigger = a.api().largerEmoteUrl;
    assertEqual(bigger('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'),
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0');
    assertEqual(bigger('https://cdn.7tv.app/emote/1/2x.webp'), 'https://cdn.7tv.app/emote/1/4x.webp');
    assertEqual(bigger('https://cdn.betterttv.net/emote/1/2x'), 'https://cdn.betterttv.net/emote/1/3x');
    assertEqual(bigger('https://cdn.frankerfacez.com/emote/1/2'), 'https://cdn.frankerfacez.com/emote/1/4');
  });

  it('leaves a host it does not know alone rather than breaking the image', async () => {
    const a = await boot();
    assertEqual(a.api().largerEmoteUrl('https://files.kick.com/emotes/1/fullsize'),
      'https://files.kick.com/emotes/1/fullsize');
    assertEqual(a.api().largerEmoteUrl(''), '');
  });

  it('carries the source on the emote so the preview can name it', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/catjam.webp', source: '7TV' } };
    a.api().addMsg('twitch', 'user', 'catJAM', {});
    a.flush();
    const img = a.$('#feed .chat-emote');
    assertEqual(img.dataset.source, '7TV');
    // No `title`: the app draws its own preview, and two tooltips for one emote
    // is worse than either alone.
    assertEqual(img.getAttribute('title'), null);
  });
});

describe('render: kick events', () => {
  it('names what was redeemed rather than only "channel points"', async () => {
    const a = await boot();
    assertEqual(a.api().formatKickEventSummary('App\\Events\\ChannelPointsRedeemedEvent', {
      username: 'Alice', reward_title: 'Feed the hedgehog',
    }), 'Alice redeemed Feed the hedgehog.');
  });

  it('drops housekeeping events instead of filling the feed with them', async () => {
    const a = await boot();
    const api = a.api();
    ['App\\Events\\ChatroomUpdatedEvent', 'App\\Events\\StreamerIsLiveStatisticEvent',
      'App\\Events\\PinnedMessageCreatedEvent'].forEach(name => {
      assertEqual(api.formatKickEventSummary(name, {}), '', `${name} should be dropped`);
    });
  });

  it('still describes the events worth a row', async () => {
    const a = await boot();
    const api = a.api();
    assertEqual(api.formatKickEventSummary('App\\Events\\SubscriptionEvent', { username: 'Alice' }),
      'Alice subscribed.');
    // A leaderboard update that carries a real gift count is mapped by name, so
    // the housekeeping filter never sees it.
    assertIncludes(api.formatKickEventSummary('App\\Events\\GiftsLeaderboardUpdated',
      { gifter_username: 'Alice', gifted_quantity: 5 }), 'Alice gifted 5 subs.');
  });

  it('survives a null payload from the socket', async () => {
    const a = await boot();
    assertEqual(a.api().formatKickEventSummary('App\\Events\\SubscriptionEvent', null),
      'Someone subscribed.');
  });
});

describe('send: replies thread onto the original', () => {
  it('sends the parent id when the composer still holds the reply', async () => {
    const a = await boot();
    const api = a.api();
    api.replyToUser('Alice', 'twitch', 'abc123');
    assertEqual(api.takePendingReply('twitch', '@Alice sure'), 'abc123');
    // A different platform's send must not pick up Twitch's parent.
    assertEqual(api.takePendingReply('kick', '@Alice sure'), '');
  });

  it('drops the thread once the viewer has typed something else', async () => {
    const a = await boot();
    const api = a.api();
    api.replyToUser('Alice', 'twitch', 'abc123');
    assertEqual(api.takePendingReply('twitch', 'never mind'), '');
  });

  it('stays an ordinary mention where the platform cannot thread it', async () => {
    const a = await boot();
    const api = a.api();
    api.replyToUser('Alice', 'kick', 'abc123');
    assertEqual(api.takePendingReply('kick', '@Alice sure'), '');
  });

  it('formats a duration in the unit a reader wanted', async () => {
    const a = await boot();
    const d = a.api().formatDuration;
    assertEqual([d(30), d(300), d(3600), d(7200)], ['30s', '5m', '1h', '2h']);
  });
});
