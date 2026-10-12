'use strict';
// RDS smoke test — run it against YOUR running server:
//   node smoke-test.js                       (checks every page + headers + read-only APIs, http://localhost:3000)
//   node smoke-test.js http://localhost:3000 --write
//        (also signs in with the test code 1234, uploads a photo + a video, posts a story and a post, and plays the video with Range)
//   node smoke-test.js https://your-app.onrender.com
// Needs Node 18+. --write creates a few test items (stories expire in 24 h) and only works while test codes are allowed.
const BASE = (process.argv.find(a => /^https?:\/\//.test(a)) || 'http://localhost:3000').replace(/\/+$/, '');
const WRITE = process.argv.includes('--write');
let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); } };
const get = async (p, opts) => { try { const r = await fetch(BASE + p, Object.assign({ redirect: 'manual' }, opts)); const t = await r.text(); return { r, t, s: r.status }; } catch (e) { return { r: null, t: '', s: 0, err: e.message }; } };
const json = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };

(async () => {
    console.log('\nRDS smoke test  →  ' + BASE + (WRITE ? '   (with --write)' : '   (read-only)') + '\n');

    console.log('PAGES (each address must show ITS OWN page)');
    const pages = [
        ['/app', 'Choose your app'], ['/launcher.html', 'Choose your app'], ['/laucher.html', null, 302],
        ['/', 'RDS Social'], ['/ads', 'RDS Social'],
        ['/user', 'Shop', 200, 'Master Control'], ['/store', 'Master Control'],
        ['/driver', 'RDS Rider'], ['/merchant', 'Vendor Console'], ['/admin', 'Sovereign Financial OS'],
        ['/print', 'DoseColor'], ['/wallet', null], ['/platform', null], ['/platform-admin', null],
        ['/manifest.webmanifest', 'RDS Sovereign Enterprise'], ['/sw.js', 'rds-shell']
    ];
    for (const [p, must, want = 200, mustNot] of pages) {
        const x = await get(p);
        if (x.s === 0) { ok(p, false, 'server not reachable (' + x.err + ') — is it running?'); continue; }
        let good = x.s === want; let why = 'HTTP ' + x.s;
        if (good && must && !x.t.includes(must)) { good = false; why = 'page does not contain "' + must + '" (wrong file saved under this name?)'; }
        if (good && mustNot && x.t.includes(mustNot)) { good = false; why = 'shows the "' + mustNot + '" page instead'; }
        ok(p + (must ? '  → ' + must : ''), good, good ? '' : why);
    }

    console.log('\nSERVER HEALTH & HEADERS');
    const h = await get('/health'); ok('/health says OK', h.s === 200 && /"status":"OK"/.test(h.t));
    const rz = await get('/readyz'); ok('/readyz ready (audit chain valid)', rz.s === 200, 'HTTP ' + rz.s + ' ' + rz.t.slice(0, 120));
    const a = await get('/ads'); const csp = (a.r && a.r.headers.get('content-security-policy')) || '';
    ok('security policy allows video (media-src blob:)', /media-src[^;]*blob:/.test(csp), 'CSP has no media-src — video preview/stories will be blocked');
    ok('camera + microphone allowed for this site', /camera=\(self\)/.test((a.r && a.r.headers.get('permissions-policy')) || ''));

    console.log('\nSECURITY (these files must NOT be downloadable)');
    for (const p of ['/server.js', '/routes/wallet.js', '/routes/ads.js', '/mpesa-config.env', '/notify-config.env', '/.env', '/set-admin-password.bat', '/smoke-test.js', '/rds-stage192-deploy.zip', '/server.js.', '/routes%5Cwallet.js']) {
        const x = await get(p);
        ok(p + ' is blocked', x.s === 404 || x.s === 403 || x.s === 400 || x.s === 302, 'HTTP ' + x.s + (x.s === 200 ? ' — the file is PUBLIC, anyone can download it' : ''));
    }

    console.log('\nSOCIAL / ADS (read-only)');
    const feed = await get('/api/ads/feed?tab=foryou&cursor=0&limit=8'); const fj = json(feed.t); ok('feed loads', feed.s === 200 && fj && fj.success, 'HTTP ' + feed.s + ' ' + feed.t.slice(0, 100));
    const st = await get('/api/ads/stories'); const sj = json(st.t); ok('stories list loads', st.s === 200 && sj && sj.success, 'HTTP ' + st.s);
    const lv = await get('/api/ads/live'); ok('live list loads', lv.s === 200, 'HTTP ' + lv.s);

    if (WRITE) {
        console.log('\nEND-TO-END (sign in → upload → post → story → play video)');
        const phone = '07' + String(Math.floor(10000000 + Math.random() * 89999999));
        const rc = await get('/api/ads/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
        const rcj = json(rc.t); ok('request sign-in code', rc.s === 200 && rcj && rcj.success, rc.t.slice(0, 120));
        const vf = await get('/api/ads/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: (rcj && rcj.phone) || phone, code: '1234' }) });
        const vj = json(vf.t); const token = vj && vj.token; ok('sign in with test code 1234', !!token, 'test codes are OFF on this server (production) — ' + vf.t.slice(0, 100));
        if (token) {
            const A = { Authorization: 'Bearer ' + token };
            const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
            const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8), Buffer.alloc(4096, 1)]);
            const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
            const up = async (buf, type) => { const r = await get('/api/ads/media', { method: 'POST', headers: Object.assign({ 'Content-Type': type }, A), body: buf }); return { s: r.s, j: json(r.t) }; };
            const u1 = await up(png, 'image/png'); ok('upload a photo', u1.s === 200 && u1.j && u1.j.kind === 'image', JSON.stringify(u1.j));
            const u2 = await up(mp4, 'video/mp4'); ok('upload a video', u2.s === 200 && u2.j && u2.j.kind === 'video', JSON.stringify(u2.j));
            const u3 = await up(heic, 'image/heic'); ok('HEIC photo is refused (not stored as a video)', u3.s === 415, 'HTTP ' + u3.s);
            const u4 = await up(mp4, 'video/mp4');
            const J = { 'Content-Type': 'application/json' };
            const p = await get('/api/ads/posts', { method: 'POST', headers: Object.assign({}, J, A), body: JSON.stringify({ caption: 'smoke test video', mediaId: u2.j && u2.j.mediaId, audience: 'public' }) }); const pj = json(p.t);
            ok('post a video', p.s === 200 && pj && pj.success, p.t.slice(0, 140));
            const s1 = await get('/api/ads/stories', { method: 'POST', headers: Object.assign({}, J, A), body: JSON.stringify({ mediaId: u1.j && u1.j.mediaId, text: 'smoke photo' }) }); ok('add a photo story', s1.s === 200 && (json(s1.t) || {}).success, s1.t.slice(0, 140));
            const s2 = await get('/api/ads/stories', { method: 'POST', headers: Object.assign({}, J, A), body: JSON.stringify({ mediaId: u4.j && u4.j.mediaId, text: '' }) }); ok('add a video story', s2.s === 200 && (json(s2.t) || {}).success, s2.t.slice(0, 140));
            const s3 = await get('/api/ads/stories', { method: 'POST', headers: Object.assign({}, J, A), body: JSON.stringify({ text: 'smoke text story', style: 'ocean' }) }); ok('add a text story', s3.s === 200 && (json(s3.t) || {}).success, s3.t.slice(0, 140));
            const mine = await get('/api/ads/stories', { headers: A }); const mj = json(mine.t); const me = mj && mj.stories && mj.stories.find(x => x.isMe);
            ok('my 3 stories are listed', !!me && me.items.length === 3, me ? me.items.length + ' found' : 'none');
            const vid = me && me.items.find(i => i.media && i.media.kind === 'video');
            if (vid) {
                const rg = await get(vid.media.url, { headers: { Range: 'bytes=0-99' } });
                ok('video plays in pieces (Range → 206)', rg.s === 206, 'HTTP ' + rg.s);
                ok('video served as video/mp4', ((rg.r && rg.r.headers.get('content-type')) || '').includes('video/mp4'));
            } else ok('video story present', false);
            const fd = await get('/api/ads/feed?tab=foryou&cursor=0&limit=8', { headers: A }); const fdj = json(fd.t);
            ok('the video post shows in the feed', !!(fdj && fdj.posts && fdj.posts.some(x => x.caption === 'smoke test video' && x.media && x.media.kind === 'video')));
        }
    }

    console.log('\n' + (fail ? '✗ ' + fail + ' FAILED' : '✓ ALL PASSED') + '   (' + pass + ' passed, ' + fail + ' failed)');
    if (failures.length) { console.log('\nWhat to fix:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(fail ? 1 : 0);
})();