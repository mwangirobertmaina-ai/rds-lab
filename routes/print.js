'use strict';
// ============================================================================
// routes/print.js — DoseColor: dosing-frequency labels for hospitals, clinics and pharmacies (mounted at /api/print)
//
// WHAT IT DOES
//   * Reads a prescription instruction ("Amoxicillin 500mg 1x3 x 5/7", "Paracetamol 1g TDS after food", "Insulin 10u nocte") and works out
//     how often it is taken, with the exact words that led to that reading.
//   * A pharmacist or clinician CONFIRMS the reading before anything prints. If the text is unclear or contradicts itself, nothing is
//     chosen for them: they pick the frequency and give a reason. Every override is recorded.
//   * Prints a label that never relies on colour alone: colour + big words + symbols + morning / noon / evening / night tick boxes,
//     so it still works on black-and-white thermal printers and for colour-blind patients.
//   * Many facilities: each hospital / clinic / pharmacy has its own staff (phone sign-in), its own label numbers, its own print agents.
//   * Print agents: a small program on the facility PC intercepts label print jobs and adds the frequency banner (tools/dosecolor-agent.js).
//
// SAFETY RULES (each one fixes a defect in the previous version)
//   * Abbreviations are matched as whole words only: "od" no longer matches inside "food", "blood" or "codeine".
//   * Two different frequencies in one instruction = AMBIGUOUS, never a silent guess.
//   * "OD" next to eye drops is flagged (it can mean RIGHT EYE). "QD" is flagged (on the do-not-use list). Weekly doses get a loud warning.
//   * "x 5/7" is a duration (5 days), never a frequency.
//   * The server returns data, never HTML. The page builds the label with text only.
//   * Prescription text is NOT stored unless the facility turns that on; only a keyed hash, the category and who printed it.
// IMPORTANT: this is a support tool. It does not replace the pharmacist's check, and the colour convention is RDS's, not a national
// standard. Each facility should approve it through its pharmacy & therapeutics committee before clinical use.
// ============================================================================
// ============================================================================
// 0. THE PRINT AGENT (this same file runs on the pharmacy PC:  node print.js )
//    It needs NO packages (no Express): only Node.js 18+. Everything below the "SERVER" line is skipped in agent mode.
//    Setup: DoseColor page -> Facility -> Print agents -> "Create agent key" -> "Download agent" (this file).
//    Put a dosecolor-agent.json next to it:
//      { "server": "https://YOUR-SERVER", "key": "dck_...", "listenHost": "127.0.0.1", "listenPort": 9100,
//        "printer": { "host": "192.168.1.50", "port": 9100 }, "windowsPrinter": null, "timeoutMs": 4000 }
//    Then in Windows add a printer "using a TCP/IP address" -> 127.0.0.1 port 9100 (Generic / Text Only, or the thermal driver),
//    and print labels to it from your hospital / pharmacy system.
//    For every job: plain-text / ESC/POS jobs are read; if the server is CERTAIN a frequency banner is printed first, then the
//    ORIGINAL job byte for byte. In every other case (unclear, safety warning, server down or slow, PDF/PCL/ZPL job, any error)
//    the ORIGINAL job is printed exactly as sent. The agent never writes prescription text to disk or to its log.
// ============================================================================
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
function loadConfig() {
    const file = process.env.DOSECOLOR_CONFIG || path.join(__dirname, 'dosecolor-agent.json');
    let c = {};
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error('dosecolor-agent.json is not valid JSON: ' + e.message); process.exit(2); } }
    const env = process.env;
    const cfg = {
        server: String(env.DOSECOLOR_SERVER || c.server || '').replace(/\/+$/, ''),
        key: String(env.DOSECOLOR_KEY || c.key || ''),
        listenHost: env.DOSECOLOR_LISTEN_HOST || c.listenHost || '127.0.0.1',
        listenPort: Number(env.DOSECOLOR_LISTEN_PORT || c.listenPort || 9100),
        printer: c.printer || (env.DOSECOLOR_PRINTER_HOST ? { host: env.DOSECOLOR_PRINTER_HOST, port: Number(env.DOSECOLOR_PRINTER_PORT || 9100) } : null),
        windowsPrinter: env.DOSECOLOR_WINDOWS_PRINTER || c.windowsPrinter || null,
        outDir: env.DOSECOLOR_OUT_DIR || c.outDir || null,                       // testing: write jobs to files instead of a printer
        timeoutMs: Number(env.DOSECOLOR_TIMEOUT_MS || c.timeoutMs || 4000),
        maxJobBytes: Number(c.maxJobBytes || 10 * 1048576),
        idleMs: Number(c.idleMs || 2500)
    };
    const problems = [];
    if (!/^https?:\/\/[^\s]+$/.test(cfg.server)) problems.push('"server" must be the address of your RDS server, e.g. https://rds-lab.onrender.com');
    if (!/^dck_[A-Za-z0-9_-]{20,60}$/.test(cfg.key)) problems.push('"key" must be the agent key from DoseColor -> Facility -> Print agents (it starts with dck_)');
    if (!cfg.printer && !cfg.windowsPrinter && !cfg.outDir) problems.push('set "printer": {"host": "...", "port": 9100} or "windowsPrinter": "\\\\\\\\localhost\\\\ShareName"');
    if (/^http:\/\//.test(cfg.server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(cfg.server)) problems.push('use https:// for the server (the agent key must not travel unencrypted)');
    return { cfg, problems };
}

// ---------------------------------------------------------------------------
// reading text out of a print job (plain text or ESC/POS); anything else is not touched
// ---------------------------------------------------------------------------
function jobKind(buf) {
    const head = buf.slice(0, 16).toString('latin1');
    if (head.startsWith('%PDF')) return 'PDF';
    if (head.startsWith('%!PS') || head.startsWith('\x04%!')) return 'POSTSCRIPT';
    if (head.startsWith('\x1bE') || head.startsWith('\x1b%-12345X')) return 'PCL';
    if (/^(\^XA|\x02L|N\r?\n|SIZE |CLS)/.test(head)) return 'LABEL_LANGUAGE';      // ZPL / DPL / EPL / TSPL: barcode label printers
    return 'TEXT_OR_ESCPOS';
}
function extractText(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === 0x1B) {                       // ESC
            const c = buf[i + 1];
            if (c === undefined) break;
            const ch = String.fromCharCode(c);
            if (ch === '@') { i += 1; continue; }
            if ('aE!dJMtG-R{VcUe3'.includes(ch)) { i += 2; continue; }        // ESC x n
            if (ch === 'p') { i += 4; continue; }                              // ESC p m t1 t2
            if (ch === '*') { const m = buf[i + 2], n = (buf[i + 3] || 0) + (buf[i + 4] || 0) * 256; i += 4 + n * (m >= 32 ? 3 : 1); continue; }
            if (ch === '$' || ch === '\\') { i += 3; continue; }               // ESC $ nL nH
            i += 1; continue;
        }
        if (b === 0x1D) {                       // GS
            const ch = String.fromCharCode(buf[i + 1] || 0);
            if (ch === 'V') { const m = buf[i + 2]; i += (m === 65 || m === 66 || m === 97 || m === 98) ? 3 : 2; continue; }
            if ('!BbhwHfIar'.includes(ch)) { i += 2; continue; }
            if (ch === 'L' || ch === 'W') { i += 3; continue; }
            if (ch === 'k') { const m = buf[i + 2]; if (m <= 6) { let j = i + 3; while (j < buf.length && buf[j] !== 0) j++; i = j; } else i += 3 + (buf[i + 3] || 0); continue; }
            if (ch === 'v' && buf[i + 2] === 0x30) { const x = (buf[i + 4] || 0) + (buf[i + 5] || 0) * 256, y = (buf[i + 6] || 0) + (buf[i + 7] || 0) * 256; i += 7 + x * y; continue; }
            if (ch === '(') { const n = (buf[i + 3] || 0) + (buf[i + 4] || 0) * 256; i += 4 + n; continue; }
            i += 1; continue;
        }
        if (b === 0x1C) { i += 1; continue; }   // FS x
        if (b === 0x0A) { out.push(0x0A); continue; }
        if (b === 0x09) { out.push(0x20); continue; }
        if (b === 0x0D || b < 0x20 || b === 0x7F) continue;
        out.push(b);
    }
    const raw = Buffer.from(out);
    let text = raw.toString('utf8');
    if (text.includes('\uFFFD')) text = raw.toString('latin1');
    return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

// ---------------------------------------------------------------------------
// the banner (ESC/POS, plain ASCII so every thermal code page prints it)
// ---------------------------------------------------------------------------
function bannerBytes(lines) {
    const ascii = (s) => String(s).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, 42);
    const parts = [Buffer.from([0x1B, 0x40, 0x1B, 0x61, 0x01])];                     // init, centre
    lines.forEach((l, i) => {
        if (i === 0) parts.push(Buffer.from([0x1D, 0x21, 0x11, 0x1B, 0x45, 0x01]), Buffer.from(ascii(l) + '\n'), Buffer.from([0x1B, 0x45, 0x00, 0x1D, 0x21, 0x00]));
        else parts.push(Buffer.from(ascii(l) + '\n'));
    });
    parts.push(Buffer.from('------------------------------\n'), Buffer.from([0x1B, 0x61, 0x00]));   // rule, left align again
    return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// talking to the server (never longer than timeoutMs; any problem = PASS)
// ---------------------------------------------------------------------------
async function ask(cfg, text) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
        const r = await fetch(cfg.server + '/api/print/agent/process', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'X-DoseColor-Key': cfg.key }, body: JSON.stringify({ text }) });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || d.success !== true) return { action: 'PASS', reason: (d && d.error) || `server answered ${r.status}` };
        return d;
    } catch (e) { return { action: 'PASS', reason: e.name === 'AbortError' ? `server did not answer within ${cfg.timeoutMs} ms` : 'server not reachable' }; }
    finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// sending to the real printer (3 tries; if it still fails the job is kept in failed/ so nothing is lost)
// ---------------------------------------------------------------------------
function sendTcp(p, data) {
    return new Promise((resolve, reject) => {
        const s = net.connect({ host: p.host, port: p.port || 9100 }); let done = false;
        const end = (e) => { if (done) return; done = true; s.destroy(); e ? reject(e) : resolve(); };
        s.setTimeout(15000, () => end(new Error('printer timeout')));
        s.on('error', end); s.on('connect', () => s.end(data)); s.on('close', () => end());
    });
}
function sendWindows(share, data) {
    return new Promise((resolve, reject) => {
        const tmp = path.join(os.tmpdir(), `dosecolor-${process.pid}-${Date.now()}.prn`);
        fs.writeFileSync(tmp, data);
        execFile('cmd.exe', ['/c', 'copy', '/b', tmp, share], { windowsHide: true }, (err) => { fs.unlink(tmp, () => {}); err ? reject(err) : resolve(); });
    });
}
let seq = 0;
async function deliver(cfg, data, tag) {
    if (cfg.outDir) { fs.mkdirSync(cfg.outDir, { recursive: true }); fs.writeFileSync(path.join(cfg.outDir, `${Date.now()}-${++seq}-${tag}.prn`), data); return; }
    let last;
    for (let i = 0; i < 3; i++) {
        try { if (cfg.printer) await sendTcp(cfg.printer, data); else await sendWindows(cfg.windowsPrinter, data); return; }
        catch (e) { last = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
    }
    const dir = path.join(__dirname, 'failed'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${Date.now()}-${tag}.prn`); fs.writeFileSync(f, data);
    console.error(`!!! PRINTER NOT REACHABLE (${last && last.message}). The job was saved to ${f}. Check the printer, then print that file again.`);
}

// ---------------------------------------------------------------------------
// one print job
// ---------------------------------------------------------------------------
async function handleJob(cfg, job) {
    const kind = jobKind(job);
    let out = job, action = 'PASS', why = '', ref = '';
    try {
        if (job.length > cfg.maxJobBytes) why = 'job too large to read';
        else if (kind !== 'TEXT_OR_ESCPOS') why = `${kind} job (not read)`;
        else {
            const text = extractText(job);
            if (!text) why = 'no readable text';
            else {
                const d = await ask(cfg, text);
                if (d.action === 'ENHANCE' && Array.isArray(d.banner) && d.banner.length) { out = Buffer.concat([bannerBytes(d.banner), job]); action = 'ENHANCE'; ref = d.ref || ''; }
                else why = d.reason || 'not certain';
            }
        }
    } catch (e) { out = job; action = 'PASS'; why = 'agent error: ' + e.message; }
    await deliver(cfg, out, action);
    console.log(`${new Date().toISOString()}  job ${job.length} bytes  ${action === 'ENHANCE' ? 'BANNER ADDED  ' + ref : 'printed as sent (' + why + ')'}`);
    return { action, why, ref, bytes: out.length };
}

// ---------------------------------------------------------------------------
// the virtual printer
// ---------------------------------------------------------------------------
function start(cfg) {
    const srv = net.createServer((sock) => {
        const chunks = []; let size = 0, idle = null, finished = false;
        const finish = () => { if (finished) return; finished = true; clearTimeout(idle); const job = Buffer.concat(chunks); if (job.length) handleJob(cfg, job).then(r => srv.emit('job', r)); };
        sock.on('data', (c) => { chunks.push(c); size += c.length; clearTimeout(idle); idle = setTimeout(() => { finish(); sock.end(); }, cfg.idleMs); if (size > cfg.maxJobBytes * 2) { finish(); sock.destroy(); } });
        sock.on('end', finish); sock.on('error', finish);
    });
    srv.listen(cfg.listenPort, cfg.listenHost, () => console.log(`DoseColor agent listening on ${cfg.listenHost}:${srv.address().port} -> ${cfg.outDir ? 'folder ' + cfg.outDir : cfg.printer ? cfg.printer.host + ':' + (cfg.printer.port || 9100) : cfg.windowsPrinter}`));
    return srv;
}

function agentMain() {
    const { cfg, problems } = loadConfig();
    if (problems.length) { console.error('DoseColor agent cannot start:\n - ' + problems.join('\n - ')); process.exit(2); }
    start(cfg);
}
if (require.main === module) { agentMain(); return; }       // agent mode ends here: the server code below is never loaded

// ============================================================================
// SERVER (loaded by server.js and mounted at /api/print)
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { createStore } = require('./dosecolor-store');

let D = {}, ready = false, file = null, saveTimer = null, store = null, flushing = false, flushAgain = false, readyPromise = Promise.resolve();
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = (p) => `${p}_${now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const fail = (res, code, msg, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const okId = (v, p) => typeof v === 'string' && new RegExp(`^${p}_[a-z0-9]{8,40}$`).test(v);

// ============================================================================
// 1. THE PARSER
// ============================================================================
const CATEGORIES = {
    ONCE_DAILY:   { color: '#15803d', name: 'Green',  label: 'ONCE A DAY',             perDay: 1, slots: ['MORNING'],                          symbol: '☀' },
    TWICE_DAILY:  { color: '#1d4ed8', name: 'Blue',   label: 'TWICE A DAY',            perDay: 2, slots: ['MORNING', 'NIGHT'],                 symbol: '☀ ☾' },
    THREE_DAILY:  { color: '#c2410c', name: 'Orange', label: 'THREE TIMES A DAY',      perDay: 3, slots: ['MORNING', 'AFTERNOON', 'NIGHT'],    symbol: '☀ ◐ ☾' },
    FOUR_DAILY:   { color: '#b91c1c', name: 'Red',    label: 'FOUR TIMES A DAY',       perDay: 4, slots: ['MORNING', 'NOON', 'EVENING', 'NIGHT'], symbol: '☀ ☀ ◐ ☾' },
    FREQUENT:     { color: '#6d28d9', name: 'Purple', label: 'MORE THAN 4 TIMES A DAY', perDay: null, slots: [],                                 symbol: '⏱' },
    AS_NEEDED:    { color: '#a16207', name: 'Yellow', label: 'ONLY WHEN NEEDED',       perDay: null, slots: [],                                 symbol: '?' },
    ONCE_ONLY:    { color: '#334155', name: 'Grey',   label: 'ONE DOSE ONLY',          perDay: null, slots: [],                                 symbol: '1' },
    WEEKLY:       { color: '#9d174d', name: 'Magenta', label: 'ONCE A WEEK - NOT DAILY', perDay: null, slots: [],                               symbol: '7' }
};
const WORD = (w) => new RegExp(`(?<![a-z0-9])${w}(?![a-z0-9])`, 'i');
const SIGNALS = [
    // [category, regex, meaning]
    ['ONCE_DAILY', WORD('od'), 'OD = once daily'], ['ONCE_DAILY', WORD('qd'), 'QD = once daily'], ['ONCE_DAILY', WORD('daily'), 'daily', 'GENERIC'],
    ['ONCE_DAILY', /once (?:a |per |each )?day|once daily|one time (?:a |per )?day/i, 'once a day'], ['ONCE_DAILY', /24[- ]?hourly|every 24 ?h(?:ou)?rs?|q24h/i, 'every 24 hours'],
    ['ONCE_DAILY', WORD('mane'), 'mane = in the morning'], ['ONCE_DAILY', WORD('nocte'), 'nocte = at night'], ['ONCE_DAILY', WORD('hs'), 'HS = at bedtime'],
    ['ONCE_DAILY', /at (?:night|bedtime)|before bed|every (?:night|morning)|in the morning/i, 'once, at a set time of day'],
    ['ONCE_DAILY', /mara moja (?:kwa|kila) siku|asubuhi tu|usiku tu/i, 'Swahili: once a day'], ['ONCE_DAILY', /kila siku|kwa siku/i, 'Swahili: every day', 'GENERIC'],
    ['TWICE_DAILY', WORD('bd'), 'BD = twice daily'], ['TWICE_DAILY', WORD('bid'), 'BID = twice daily'], ['TWICE_DAILY', /twice (?:a |per |each )?day|twice daily/i, 'twice a day'],
    ['TWICE_DAILY', /12[- ]?hourly|every 12 ?h(?:ou)?rs?|q12h/i, 'every 12 hours'], ['TWICE_DAILY', /mara mbili/i, 'Swahili: twice'],
    ['THREE_DAILY', WORD('tds'), 'TDS = three times daily'], ['THREE_DAILY', WORD('tid'), 'TID = three times daily'], ['THREE_DAILY', /thrice (?:a |per )?day|three times/i, 'three times'],
    ['THREE_DAILY', /8[- ]?hourly|every 8 ?h(?:ou)?rs?|q8h/i, 'every 8 hours'], ['THREE_DAILY', /mara tatu/i, 'Swahili: three times'],
    ['FOUR_DAILY', WORD('qid'), 'QID = four times daily'], ['FOUR_DAILY', WORD('qds'), 'QDS = four times daily'], ['FOUR_DAILY', /four times/i, 'four times'],
    ['FOUR_DAILY', /6[- ]?hourly|every 6 ?h(?:ou)?rs?|q6h/i, 'every 6 hours'], ['FOUR_DAILY', /mara nne/i, 'Swahili: four times'],
    ['FREQUENT', /(?<![0-9])(?:[1-4])[- ]?hourly|every (?:[1-4]) ?h(?:ou)?rs?|q[1-4]h(?![a-z])|every (?:hour|two hours)/i, 'more than four times a day'],
    ['AS_NEEDED', WORD('prn'), 'PRN = only when needed'], ['AS_NEEDED', WORD('sos'), 'SOS = only when needed'],
    ['AS_NEEDED', /as (?:needed|required)|when (?:needed|required)|if (?:needed|required)|for pain|inapohitajika|ikihitajika/i, 'only when needed'],
    ['ONCE_ONLY', WORD('stat'), 'STAT = one dose now'], ['ONCE_ONLY', /single dose|one dose only|once only|immediately/i, 'one dose only'],
    ['WEEKLY', /weekly|once (?:a|per|every) week|every week|kila wiki|wiki moja/i, 'once a week']
];
const PER_DAY_CAT = { 1: 'ONCE_DAILY', 2: 'TWICE_DAILY', 3: 'THREE_DAILY', 4: 'FOUR_DAILY', 5: 'FREQUENT', 6: 'FREQUENT' };

function analyze(raw) {
    const text = clean(raw, 1000);
    // "b.d." "t.d.s" "o.d" -> "bd" "tds" "od"
    const t = text.replace(/\b([a-z])\.(?=[a-z]\.?)/gi, '$1').replace(/\b([a-z]{1,2})\.(?![a-z0-9])/gi, '$1');
    const found = [], warnings = [];
    for (const [cat, re, meaning, kind] of SIGNALS) { const m = re.exec(t); if (m) found.push({ category: cat, match: m[0], meaning, generic: kind === 'GENERIC' }); }
    // dose x frequency (x days) — the common Kenyan "1x3", "2 x 2", "1*3", "1 by 2". The second number is times per day.
    // "x 5/7" (days) and "x 2/52" (weeks) are durations and are skipped. A number with a unit (500mg x 3) is ambiguous and is NOT read.
    const doseRe = /(?<![0-9.])(\d{1,2}(?:\.\d)?|½|half|one|two)\s*(?:tabs?|caps?|tablets?|capsules?|puffs?|drops?|sachets?|ml\b)?\s*(?:x|\*|by)\s*(\d)(?!\s*\/\s*(?:7|52|12))(?![0-9])(?!\s*(?:days?|dys?|d|siku|weeks?|wks?|wiki|months?|mos?|hrs?|hours?)(?![a-z]))/gi;
    let m;
    while ((m = doseRe.exec(t))) {
        // ("500mg x 3" cannot match here: a 3-digit strength is not a dose count; it is caught by the UNIT_TIMES warning below)
        const n = Number(m[2]); if (n >= 1 && n <= 6) found.push({ category: PER_DAY_CAT[n], match: m[0], meaning: `${m[1]} x ${n} = ${n} times a day` });
    }
    const timesRe = /(?<![0-9.])([1-6])\s*(?:times|x)\s*(?:a|per|each|daily|in a)?\s*(?:day|daily)/gi;
    while ((m = timesRe.exec(t))) found.push({ category: PER_DAY_CAT[Number(m[1])], match: m[0], meaning: `${m[1]} times a day` });
    if (/(?<![0-9.])\d+(?:\.\d+)?\s*(mg|mcg|g)\s*(?:x|\*)\s*\d(?!\s*\/)/i.test(t)) warnings.push({ code: 'UNIT_TIMES', text: 'A strength is followed by "x N" (for example "500mg x 3"). It is unclear whether N is times a day or days. Write it out in full.' });

    // duration
    let durationDays = null, dm;
    if ((dm = /(?:x|for)\s*(\d{1,3})\s*\/\s*7(?![0-9])/i.exec(t))) durationDays = Number(dm[1]);
    else if ((dm = /(?:x|for)\s*(\d{1,2})\s*\/\s*52(?![0-9])/i.exec(t))) durationDays = Number(dm[1]) * 7;
    else if ((dm = /(?:x|for)\s*(\d{1,3})\s*(?:days?|siku)/i.exec(t))) durationDays = Number(dm[1]);
    else if ((dm = /(?:x|for)\s*(\d{1,2})\s*(?:weeks?|wiki)/i.exec(t))) durationDays = Number(dm[1]) * 7;

    // time-of-day hints
    const morning = /\bmane\b|in the morning|asubuhi/i.test(t), night = /\bnocte\b|\bhs\b|at night|at bedtime|before bed|usiku/i.test(t);
    // safety warnings
    if (WORD('od').test(t) && /drop|eye|ophthalm|ocular|macho/i.test(t)) warnings.push({ code: 'OD_EYE', text: '"OD" next to eye drops can mean RIGHT EYE, not once daily. Write "right eye" or "once a day" in full.' });
    if (WORD('qd').test(t)) warnings.push({ code: 'QD', text: '"QD" is on the do-not-use list (it is mistaken for QID). Write "once a day".' });
    if (found.some(f => f.category === 'WEEKLY')) warnings.push({ code: 'WEEKLY', text: 'WEEKLY dose. Taking it every day can be dangerous (for example methotrexate). Make sure the patient understands.' });

    // decide
    if (found.some(f => !f.generic && ['TWICE_DAILY', 'THREE_DAILY', 'FOUR_DAILY', 'FREQUENT'].includes(f.category))) for (let i = found.length - 1; i >= 0; i--) if (found[i].generic) found.splice(i, 1);
    let cats = [...new Set(found.map(f => f.category))], category = null, confidence = 'NONE', maxPerDay = null;
    if (morning && night && cats.every(c => c === 'ONCE_DAILY')) { cats = ['TWICE_DAILY']; found.push({ category: 'TWICE_DAILY', match: 'morning + night', meaning: 'a dose in the morning and one at night' }); }
    if (cats.length === 1) { category = cats[0]; confidence = 'HIGH'; }
    else if (cats.length === 2 && cats.includes('AS_NEEDED')) {
        const other = cats.find(c => c !== 'AS_NEEDED');
        if (CATEGORIES[other].perDay) { category = 'AS_NEEDED'; confidence = 'HIGH'; maxPerDay = CATEGORIES[other].perDay; }
        else confidence = 'AMBIGUOUS';
    } else if (cats.length === 2 && cats.includes('WEEKLY') && cats.includes('ONCE_DAILY') && !found.some(f => f.category === 'ONCE_DAILY' && /od|qd|daily|day|siku/i.test(f.match))) { category = 'WEEKLY'; confidence = 'HIGH'; }
    else if (cats.length > 1) confidence = 'AMBIGUOUS';
    // these never print on their own: a pharmacist must confirm (QD is on the do-not-use list because it is misread as QID)
    if (warnings.some(w => w.code === 'OD_EYE' || w.code === 'UNIT_TIMES' || w.code === 'QD')) { confidence = 'AMBIGUOUS'; category = null; }
    const slots = category === 'ONCE_DAILY' ? (night && !morning ? ['NIGHT'] : ['MORNING']) : category ? CATEGORIES[category].slots : [];
    return { category, confidence, maxPerDay, durationDays, slots, evidence: found, conflicts: confidence === 'AMBIGUOUS' ? [...new Set(found.map(f => f.category))] : [], warnings };
}
const catView = (k) => ({ key: k, ...CATEGORIES[k] });

// ============================================================================
// 2. STATE (persisted to DATA_DIR/dosecolor.snapshot)
// ============================================================================
const blank = () => ({ v: 1, facilities: {}, staff: {}, sessions: {}, agents: {}, labels: [], seq: {}, products: {}, orders: [], oseq: {}, suppliers: {}, purchaseOrders: [], pseq: {} });
let S = blank();
const SORT_AT = (a, b) => ((a.createdAt || a.at || 0) - (b.createdAt || b.at || 0));
async function initStore() {
    store = createStore({ databaseUrl: D.databaseUrl || process.env.DATABASE_URL || null, file, injectPool: D.pgPool, pgSsl: D.pgSsl, pgMax: D.pgMax });
    if (store.init) await store.init();
    const loaded = await store.loadAll();
    if (loaded) { S = Object.assign(blank(), loaded); for (const k of ['orders', 'labels', 'purchaseOrders']) if (Array.isArray(S[k])) S[k].sort(SORT_AT); }
}
async function flushNow() {
    if (!store) return;
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    try { await store.flush(S); } catch (e) { console.error('[DOSECOLOR] save failed:', e.message); }
    finally { flushing = false; if (flushAgain) { flushAgain = false; return flushNow(); } }
}
function saveNow() { return flushNow(); }
const dirty = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; flushNow(); }, 800); if (saveTimer.unref) saveTimer.unref(); };
const hits = new Map();
function limited(key, max, ms) { const t = now(), a = (hits.get(key) || []).filter(x => t - x < ms); if (a.length >= max) { hits.set(key, a); return true; } a.push(t); hits.set(key, a); return false; }
const ipOf = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || 'x');
const slow = (res) => fail(res, 429, 'Too many requests. Please wait a moment.');

router.init = function init(deps) {
    D = deps || {};
    const hasDb = !!(D.databaseUrl || process.env.DATABASE_URL || D.pgPool);
    if (!D.dataDir && !hasDb) throw new Error('print module needs dataDir or databaseUrl');
    if (D.dataDir) { fs.mkdirSync(D.dataDir, { recursive: true }); file = path.join(D.dataDir, 'dosecolor.snapshot'); }
    ready = false;
    readyPromise = initStore()
        .then(() => { ready = true; console.log('[DOSECOLOR] storage ready (' + (store ? store.kind : '?') + ')'); if (typeof D.onReady === 'function') D.onReady(); })
        .catch((e) => { console.error('[DOSECOLOR] store init failed:', e && e.message); throw e; });
    readyPromise.catch(() => {});
    process.on('exit', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } if (store && store.kind === 'file') { try { store.flush(S); } catch (e) {} } });
    return readyPromise;
};
router.whenReady = () => readyPromise;
router.use((req, res, next) => (ready ? next() : fail(res, 503, 'DoseColor is starting. Try again in a moment.')));

// ============================================================================
// 3. SIGN-IN (phone + one-time code, the server's OTP system: SMS in production)
// ============================================================================
const bearer = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };
function staffOf(req) { const t = bearer(req); if (!t || !/^[A-Za-z0-9_-]{30,100}$/.test(t)) return null; const s = S.sessions[sha(t)]; if (!s || s.exp < now()) return null; return S.staff[s.sid] || null; }
const auth = (req, res, next) => { const s = staffOf(req); if (!s) return fail(res, 401, 'Please sign in.'); req.st = s; next(); };
function membership(st, fid) { const f = S.facilities[fid]; if (!f || !st) return null; const m = (f.members || {})[st.id]; return m ? { f, role: m.role } : null; }
function inFacility(req, res, adminOnly) {
    const fid = req.params.fid || (req.body && req.body.facilityId) || req.query.facilityId, m = membership(req.st, fid);
    if (!okId(String(fid || ''), 'F') || !m) { fail(res, 404, 'Facility not found.'); return null; }
    if (m.f.status === 'SUSPENDED') { fail(res, 403, 'This facility is suspended. Contact RDS support.'); return null; }
    if (adminOnly && m.role !== 'ADMIN') { fail(res, 403, 'Only the facility administrator can do this.'); return null; }
    return m;
}
router.post('/auth/request-code', (req, res) => {
    const phone = D.normalizePhone ? D.normalizePhone(String((req.body && req.body.phone) || '')) : String((req.body && req.body.phone) || '');
    if (!/^\+\d{9,15}$/.test(phone)) return fail(res, 400, 'Enter a valid phone number, for example 0712 345 678.');
    if (limited('code:' + phone, 3, 600000) || limited('codeip:' + ipOf(req), 10, 3600000)) return slow(res);
    D.issueOtp(phone);
    res.json({ success: true, phone, message: D.testMode ? 'Test mode: use code 1234.' : `We sent a code by SMS to ${phone.slice(0, 5)}***${phone.slice(-3)}.` });
});
router.post('/auth/verify', (req, res) => {
    const b = req.body || {}, phone = D.normalizePhone ? D.normalizePhone(String(b.phone || '')) : String(b.phone || ''), code = String(b.code || '').trim();
    if (!/^\+\d{9,15}$/.test(phone) || !/^\d{4,6}$/.test(code)) return fail(res, 400, 'Enter your phone number and the code you received.');
    if (limited('verify:' + ipOf(req), 30, 600000)) return slow(res);
    if (!D.checkOtp(phone, code)) return fail(res, 400, 'That code is wrong or has expired.');
    let st = Object.values(S.staff).find(x => x.phone === phone);
    if (!st) { st = { id: newId('U'), phone, name: clean(b.name, 60) || '', createdAt: now() }; S.staff[st.id] = st; }
    const tok = crypto.randomBytes(32).toString('base64url'); S.sessions[sha(tok)] = { sid: st.id, at: now(), exp: now() + 12 * 3600000 };
    for (const [h, s] of Object.entries(S.sessions)) if (s.exp < now()) delete S.sessions[h];
    dirty(); res.json({ success: true, token: tok, me: meView(st) });
});
router.post('/auth/logout', (req, res) => { const t = bearer(req); if (t) delete S.sessions[sha(t)]; dirty(); res.json({ success: true }); });
function meView(st) {
    return { id: st.id, name: st.name, phone: st.phone, facilities: Object.values(S.facilities).filter(f => f.members && f.members[st.id]).map(f => ({ id: f.id, name: f.name, type: f.type, county: f.county, role: f.members[st.id].role, status: f.status, verified: !!f.verified })) };
}
router.get('/me', auth, (req, res) => res.json({ success: true, me: meView(req.st) }));
router.patch('/me', auth, (req, res) => { const n = clean(req.body && req.body.name, 60); if (n.length < 2) return fail(res, 400, 'Enter your name.'); req.st.name = n; dirty(); res.json({ success: true, me: meView(req.st) }); });

// ============================================================================
// 4. FACILITIES, STAFF, PRINT AGENTS
// ============================================================================
const TYPES = ['HOSPITAL', 'CLINIC', 'PHARMACY', 'HEALTH_CENTRE', 'OTHER'];
router.post('/facilities', auth, (req, res) => {
    const b = req.body || {}, name = clean(b.name, 80), type = String(b.type || '').toUpperCase();
    if (name.length < 3) return fail(res, 400, 'Enter the facility name.'); if (!TYPES.includes(type)) return fail(res, 400, 'Choose hospital, clinic, pharmacy, health centre or other.');
    if (limited('fac:' + req.st.id, 5, 86400000)) return slow(res);
    if (!req.st.name && clean(b.yourName, 60).length >= 2) req.st.name = clean(b.yourName, 60);
    const id = newId('F'), code = name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X') + crypto.randomInt(100, 999);
    S.facilities[id] = { id, code, name, type, county: clean(b.county, 40), licence: clean(b.licence, 40), phone: req.st.phone, createdAt: now(), status: 'ACTIVE', verified: false, storeText: false, members: { [req.st.id]: { role: 'ADMIN', at: now() } } };
    if (D.appendAudit) D.appendAudit('DOSECOLOR_FACILITY_REGISTERED', { facilityId: id, type, by: req.st.id });
    dirty(); res.json({ success: true, facility: facilityView(S.facilities[id], 'ADMIN'), message: `${name} is set up. You can print labels now. RDS will verify the licence number.` });
});
function facilityView(f, role) {
    const today = new Date(); today.setHours(0, 0, 0, 0); const t0 = today.getTime(), mine = S.labels.filter(l => l.facilityId === f.id);
    const v = { id: f.id, code: f.code, name: f.name, type: f.type, county: f.county, licence: f.licence, status: f.status, verified: !!f.verified, storeText: !!f.storeText, role,
        stats: { labelsToday: mine.filter(l => l.at >= t0).length, labelsTotal: mine.length, overridesToday: mine.filter(l => l.at >= t0 && l.overridden).length } };
    if (role === 'ADMIN') {
        v.staff = Object.entries(f.members || {}).map(([sid, m]) => ({ id: sid, name: (S.staff[sid] || {}).name || '', phone: (S.staff[sid] || {}).phone || '', role: m.role, since: m.at }));
        v.agents = Object.values(S.agents).filter(a => a.facilityId === f.id && !a.revoked).map(a => ({ id: a.id, name: a.name, createdAt: a.createdAt, lastSeen: a.lastSeen || null, jobs: a.jobs || 0, enhanced: a.enhanced || 0 }));
    }
    return v;
}
router.get('/facilities/:fid', auth, (req, res) => { const m = inFacility(req, res); if (m) res.json({ success: true, facility: facilityView(m.f, m.role) }); });
router.patch('/facilities/:fid', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const b = req.body || {}, f = m.f;
    if (b.name !== undefined) { const n = clean(b.name, 80); if (n.length < 3) return fail(res, 400, 'Enter the facility name.'); f.name = n; }
    if (b.county !== undefined) f.county = clean(b.county, 40); if (b.licence !== undefined) { f.licence = clean(b.licence, 40); f.verified = false; }
    if (typeof b.storeText === 'boolean') f.storeText = b.storeText;
    dirty(); res.json({ success: true, facility: facilityView(f, 'ADMIN') });
});
router.post('/facilities/:fid/staff', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const b = req.body || {};
    if (b.remove) { if (b.remove === req.st.id) return fail(res, 400, 'You cannot remove yourself.'); delete m.f.members[b.remove]; dirty(); return res.json({ success: true, facility: facilityView(m.f, 'ADMIN') }); }
    const phone = D.normalizePhone ? D.normalizePhone(String(b.phone || '')) : String(b.phone || ''); if (!/^\+\d{9,15}$/.test(phone)) return fail(res, 400, 'Enter a valid phone number.');
    const role = b.role === 'ADMIN' ? 'ADMIN' : 'STAFF'; if (Object.keys(m.f.members).length >= 200) return fail(res, 400, 'A facility can have up to 200 staff.');
    let st = Object.values(S.staff).find(x => x.phone === phone); if (!st) { st = { id: newId('U'), phone, name: clean(b.name, 60), createdAt: now() }; S.staff[st.id] = st; }
    m.f.members[st.id] = { role, at: now(), by: req.st.id };
    if (D.appendAudit) D.appendAudit('DOSECOLOR_STAFF_ADDED', { facilityId: m.f.id, staffId: st.id, role, by: req.st.id });
    dirty(); res.json({ success: true, facility: facilityView(m.f, 'ADMIN'), message: `${phone} can now sign in and print for ${m.f.name}.` });
});
router.post('/facilities/:fid/agents', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const b = req.body || {};
    if (b.revoke) { const a = S.agents[b.revoke]; if (!a || a.facilityId !== m.f.id) return fail(res, 404, 'Agent not found.'); a.revoked = true; a.revokedAt = now(); dirty(); return res.json({ success: true, facility: facilityView(m.f, 'ADMIN') }); }
    if (Object.values(S.agents).filter(a => a.facilityId === m.f.id && !a.revoked).length >= 50) return fail(res, 400, 'A facility can have up to 50 print agents.');
    const key = 'dck_' + crypto.randomBytes(24).toString('base64url'), id = newId('G');
    S.agents[id] = { id, facilityId: m.f.id, name: clean(b.name, 40) || 'Pharmacy PC', keyHash: sha(key), createdAt: now(), by: req.st.id, jobs: 0, enhanced: 0 };
    if (D.appendAudit) D.appendAudit('DOSECOLOR_AGENT_CREATED', { facilityId: m.f.id, agentId: id, by: req.st.id });
    dirty(); res.json({ success: true, agentId: id, key, message: 'Copy this key now. It is shown only once.', facility: facilityView(m.f, 'ADMIN') });
});

// ============================================================================
// 5. ANALYSE AND PRINT
// ============================================================================
router.post('/analyze', (req, res) => {
    if (limited('an:' + (staffOf(req) ? staffOf(req).id : ipOf(req)), 120, 60000)) return slow(res);
    const text = clean(req.body && req.body.text, 1000); if (!text) return fail(res, 400, 'Type the prescription instruction.');
    const a = analyze(text); res.json({ success: true, analysis: { ...a, suggested: a.category ? catView(a.category) : null }, categories: Object.keys(CATEGORIES).map(catView) });
});
function nextRef(f) { S.seq[f.id] = (S.seq[f.id] || 0) + 1; return `${f.code}-${String(S.seq[f.id]).padStart(6, '0')}`; }
router.post('/labels', auth, (req, res) => {
    const m = inFacility(req, res); if (!m) return; const b = req.body || {}, f = m.f;
    if (limited('label:' + req.st.id, 300, 3600000)) return slow(res);
    const text = clean(b.text, 1000); if (!text) return fail(res, 400, 'Type the prescription instruction.');
    if (b.checked !== true) return fail(res, 400, 'Tick "I have checked this label" before printing.');
    const a = analyze(text), chosen = String(b.category || '');
    if (!CATEGORIES[chosen]) return fail(res, 400, 'Choose how often the medicine is taken.');
    const overridden = a.confidence !== 'HIGH' || a.category !== chosen, reason = clean(b.overrideReason, 200);
    if (overridden && reason.length < 5) return fail(res, 400, a.confidence === 'HIGH' ? `The instruction reads as "${CATEGORIES[a.category].label}". You chose "${CATEGORIES[chosen].label}". Give a reason.` : 'The instruction is unclear, so give a reason for the frequency you chose (for example "confirmed with prescriber").', { analysis: a });
    const maxPerDay = chosen === 'AS_NEEDED' ? (Number(b.maxPerDay) >= 1 && Number(b.maxPerDay) <= 12 ? Number(b.maxPerDay) : (a.maxPerDay || null)) : null;
    const t = now(), ref = nextRef(f);
    const rec = { id: newId('L'), ref, facilityId: f.id, by: req.st.id, at: t, category: chosen, detected: a.category, confidence: a.confidence, overridden, overrideReason: overridden ? reason : null,
        textHash: sha((f.id || '') + '|' + text), textLength: text.length, warnings: a.warnings.map(w => w.code), text: f.storeText ? text : undefined };
    S.labels.push(rec); if (S.labels.length > 200000) S.labels.splice(0, S.labels.length - 200000);
    if (D.appendAudit) D.appendAudit('DOSECOLOR_LABEL', { ref, facilityId: f.id, category: chosen, detected: a.category, overridden, by: req.st.id });
    dirty();
    const c = catView(chosen);
    res.json({ success: true, label: {
        ref, facility: { name: f.name, type: f.type, county: f.county, verified: !!f.verified }, category: c, maxPerDay, durationDays: a.durationDays,
        slots: chosen === a.category ? a.slots : c.slots, instruction: text, patientName: clean(b.patientName, 60), clinician: clean(b.clinician, 60) || req.st.name || '',
        printedBy: req.st.name || '', printedAt: t, warnings: a.warnings, overridden }, analysis: a });
});
router.get('/facilities/:fid/labels', auth, (req, res) => {
    const m = inFacility(req, res); if (!m) return;
    const list = S.labels.filter(l => l.facilityId === m.f.id).slice(-200).reverse().map(l => ({ ref: l.ref, at: l.at, category: l.category, detected: l.detected, confidence: l.confidence, overridden: l.overridden, overrideReason: l.overrideReason, warnings: l.warnings, by: (S.staff[l.by] || {}).name || (l.by && l.by.startsWith('G_') ? 'Print agent' : ''), text: m.role === 'ADMIN' ? l.text : undefined }));
    res.json({ success: true, labels: list });
});

// ============================================================================
// 6. PRINT AGENT API (tools/dosecolor-agent.js on the facility PC)
// ============================================================================
// the print agent download: this same file (it starts the agent when run with  node print.js )
router.get('/agent/download', (req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="dosecolor-agent.js"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.send(fs.readFileSync(__filename));
});
router.get('/agent/config-example', (req, res) => res.json({ success: true, file: 'dosecolor-agent.json', example: { server: 'https://YOUR-SERVER', key: 'dck_PASTE_THE_KEY_HERE', listenHost: '127.0.0.1', listenPort: 9100, printer: { host: '192.168.1.50', port: 9100 }, windowsPrinter: null, timeoutMs: 4000 } }));
router.post('/agent/process', (req, res) => {
    const key = String(req.headers['x-dosecolor-key'] || ''), a = Object.values(S.agents).find(x => !x.revoked && x.keyHash === sha(key));
    if (!/^dck_[A-Za-z0-9_-]{20,60}$/.test(key) || !a) return fail(res, 401, 'Unknown or revoked agent key.');
    const f = S.facilities[a.facilityId]; if (!f || f.status === 'SUSPENDED') return res.json({ success: true, action: 'PASS', reason: 'Facility not active.' });
    if (limited('agent:' + a.id, 600, 60000)) return res.json({ success: true, action: 'PASS', reason: 'Rate limit.' });
    const text = clean(req.body && req.body.text, 4000); a.lastSeen = now(); a.jobs = (a.jobs || 0) + 1;
    const an = analyze(text);
    // An agent only ADDS a banner when the reading is certain and has no warnings. Anything else prints exactly as sent.
    if (!text || an.confidence !== 'HIGH' || an.warnings.length) { dirty(); return res.json({ success: true, action: 'PASS', reason: !text ? 'No readable text.' : an.confidence !== 'HIGH' ? `Reading is ${an.confidence.toLowerCase()}.` : 'Has a safety warning; a person must check it.', analysis: an }); }
    a.enhanced = (a.enhanced || 0) + 1; const t = now(), ref = nextRef(f), c = catView(an.category);
    S.labels.push({ id: newId('L'), ref, facilityId: f.id, by: a.id, at: t, category: an.category, detected: an.category, confidence: 'HIGH', overridden: false, textHash: sha(f.id + '|' + text), textLength: text.length, warnings: [], viaAgent: true });
    if (D.appendAudit) D.appendAudit('DOSECOLOR_LABEL', { ref, facilityId: f.id, category: an.category, viaAgent: a.id });
    dirty();
    res.json({ success: true, action: 'ENHANCE', ref, category: c, slots: an.slots, maxPerDay: an.maxPerDay, durationDays: an.durationDays,
        banner: [c.label + (an.maxPerDay ? ` (MAX ${an.maxPerDay} A DAY)` : ''), an.slots.length ? an.slots.map(s => s + ' [ ]').join('  ') : '', an.durationDays ? `FOR ${an.durationDays} DAYS` : '', ref].filter(Boolean) });
});

// ============================================================================
// 7. OWNER (master control) + the previous version's endpoint
// ============================================================================
const adminAuth = (req, res, next) => { const chain = (D.adminAuth || []).slice(); if (!chain.length) return fail(res, 503, 'Not available.'); let i = 0; const nx = (e) => { if (e) return next(e); const f = chain[i++]; if (!f) return next(); f(req, res, nx); }; nx(); };
router.get('/admin/facilities', adminAuth, (req, res) => res.json({ success: true, facilities: Object.values(S.facilities).sort((a, b) => b.createdAt - a.createdAt).map(f => ({ ...facilityView(f, null), phone: f.phone, createdAt: f.createdAt, staff: Object.keys(f.members || {}).length })) }));
router.post('/admin/facilities/:fid', adminAuth, (req, res) => {
    const f = S.facilities[req.params.fid]; if (!f) return fail(res, 404, 'Facility not found.'); const act = String((req.body && req.body.action) || '');
    if (act === 'verify') f.verified = true; else if (act === 'unverify') f.verified = false; else if (act === 'suspend') f.status = 'SUSPENDED'; else if (act === 'restore') f.status = 'ACTIVE';
    else return fail(res, 400, 'action must be verify, unverify, suspend or restore.');
    if (D.appendAudit) D.appendAudit('DOSECOLOR_FACILITY_' + act.toUpperCase(), { facilityId: f.id, by: (req.user && (req.user.email || req.user.sub)) || 'owner' });
    dirty(); res.json({ success: true, facility: facilityView(f, null) });
});
router.post('/', (req, res) => fail(res, 410, 'This version of DoseColor is out of date and could print the wrong frequency. Reload the page.'));
function stats() {
    const t0 = now() - 86400000, L = S.labels.filter(l => l.at >= t0), F = Object.values(S.facilities);
    return { facilities: F.length, facilitiesActive: F.filter(f => f.status === 'ACTIVE').length, unverified: F.filter(f => !f.verified && f.status === 'ACTIVE').length,
        labels24h: L.length, overrides24h: L.filter(l => l.overridden).length, unclear24h: L.filter(l => l.confidence !== 'HIGH').length, agents: Object.values(S.agents).filter(a => !a.revoked).length,
        agentsSeen1h: Object.values(S.agents).filter(a => !a.revoked && a.lastSeen && now() - a.lastSeen < 3600000).length, viaAgent24h: L.filter(l => l.viaAgent).length };
}
// ============================================================================
// 8. PHARMACY SALES + DELIVERY  (Phase 1: OTC only)
//    Reuses the DoseColor label pipeline on dispense, and hands READY orders to the RDS rider network.
//    Prescription-only / controlled medicines are blocked here until the Phase 2 prescription workflow is enabled.
// ============================================================================
const kes = (c) => Math.round(c) / 100;
const parsePrice = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) && n >= 0 && n <= 1000000 ? Math.round(n * 100) : null; };
const anInt = (v, min, max, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : dflt; };
const products = (fid) => Object.values(S.products).filter(p => p.facilityId === fid && !p.retired);
const nearestExpiry = (p) => { const bs = (p.batches || []).filter(x => x.qty > 0 && x.expiry).map(x => x.expiry).sort(); return bs.length ? bs[0] : null; };
const productView = (p) => ({ id: p.id, name: p.name, form: p.form, strength: p.strength, price: kes(p.priceCents), priceCents: p.priceCents, cost: p.costCents == null ? null : kes(p.costCents), stock: p.stock, reorderLevel: p.reorderLevel || 0, low: (p.reorderLevel || 0) > 0 && (p.stock || 0) <= (p.reorderLevel || 0), otc: !!p.otc, rx: !!p.rx, controlled: !!p.controlled, coldChain: !!p.coldChain, defaultSig: p.defaultSig || '', image: p.image || null, nearestExpiry: nearestExpiry(p), batches: (p.batches || []).filter(x => x.qty > 0).map(x => ({ batchNo: x.batchNo, expiry: x.expiry, qty: x.qty })) });
const facilityByCode = (code) => Object.values(S.facilities).find(f => f.code === String(code || '').toUpperCase() && f.status === 'ACTIVE');
const DELIVERY_FEE_CENTS = () => Number(process.env.PHARMACY_DELIVERY_FEE) > 0 ? Math.round(Number(process.env.PHARMACY_DELIVERY_FEE) * 100) : 20000;   // KES 200 default
const maskPhone = (p) => { p = String(p || ''); return p.length <= 4 ? '***' : p.slice(0, 5) + '***' + p.slice(-2); };
const rxImage = (v) => { if (typeof v !== 'string') return null; if (/^https:\/\/[^\s]{1,2000}$/.test(v)) return v.slice(0, 2000); const m = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]{10,}$/.exec(v); return (m && v.length <= 4 * 1048576) ? v : null; };
function oref(f) { S.oseq[f.id] = (S.oseq[f.id] || 0) + 1; return `${f.code}-D${String(S.oseq[f.id]).padStart(5, '0')}`; }
const orderView = (o, who) => ({ ref: o.ref, status: o.status, createdAt: o.createdAt, patientName: o.patientName, phone: who === 'patient' ? o.phone : maskPhone(o.phone), address: o.address,
    items: o.lines.map(l => ({ name: l.name, strength: l.strength, form: l.form, qty: l.qty, price: kes(l.priceCents), line: kes(l.lineCents), sig: l.sig, labelRef: l.labelRef, rx: !!l.rx, controlled: !!l.controlled })),
    itemsTotal: kes(o.itemsCents), delivery: kes(o.deliveryCents), total: kes(o.totalCents), paid: !!o.paid, rider: o.rider || null, deliveryPin: who === 'patient' ? (o.deliveryPin || null) : undefined,
    rx: o.rx ? { status: o.rx.status, hasImage: !!o.rx.image, reason: o.rx.reason || null, prescriber: o.rx.prescriber || null } : null, rxImage: who === 'staff' && o.rx ? (o.rx.image || null) : undefined, idRequired: !!o.idRequired, events: o.events });

// ---- catalog (facility staff manage; admin can add/retire) ----
router.post('/facilities/:fid/products', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const b = req.body || {};
    const name = clean(b.name, 80); if (name.length < 2) return fail(res, 400, 'Enter the medicine name.');
    const price = parsePrice(b.price); if (price === null) return fail(res, 400, 'Enter a valid price in KES.');
    const controlled = b.controlled === true, rx = controlled || b.rx === true || b.pom === true;   // Phase 2: Rx / POM / controlled allowed, but a pharmacist must verify the prescription before dispatch
    if (Object.values(S.products).filter(p => p.facilityId === m.f.id && !p.retired).length >= 5000) return fail(res, 400, 'Catalog is full.');
    const cost = (b.cost === undefined || b.cost === null || b.cost === '') ? null : parsePrice(b.cost), id = newId('P');
    S.products[id] = { id, facilityId: m.f.id, name, form: clean(b.form, 30), strength: clean(b.strength, 30), priceCents: price, costCents: cost === null ? null : cost, stock: anInt(b.stock, 0, 1000000, 0), reorderLevel: anInt(b.reorderLevel, 0, 1000000, 0), otc: !rx, rx, controlled, coldChain: !!b.coldChain, defaultSig: clean(b.defaultSig, 200), image: (typeof b.image === 'string' && /^https?:\/\/[^\s]{1,500}$/.test(b.image)) ? b.image : null, batches: [], createdAt: now(), retired: false };
    if (D.appendAudit) D.appendAudit('PHARMACY_PRODUCT_ADDED', { facilityId: m.f.id, productId: id, rx, controlled, by: req.st.id });
    dirty(); res.json({ success: true, product: productView(S.products[id]) });
});
router.get('/facilities/:fid/products', auth, (req, res) => { const m = inFacility(req, res); if (!m) return; res.json({ success: true, products: products(m.f.id).map(productView) }); });
router.patch('/facilities/:fid/products/:pid', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const p = S.products[req.params.pid]; if (!p || p.facilityId !== m.f.id) return fail(res, 404, 'Product not found.'); const b = req.body || {};
    if (b.retire === true) { p.retired = true; dirty(); return res.json({ success: true }); }
    if (b.name !== undefined) { const n = clean(b.name, 80); if (n.length < 2) return fail(res, 400, 'Enter the medicine name.'); p.name = n; }
    if (b.price !== undefined) { const pr = parsePrice(b.price); if (pr === null) return fail(res, 400, 'Enter a valid price.'); p.priceCents = pr; }
    if (b.stock !== undefined) { const s = anInt(b.stock, 0, 1000000, null); if (s === null) return fail(res, 400, 'Enter a valid stock count.'); p.stock = s; }
    if (b.form !== undefined) p.form = clean(b.form, 30); if (b.strength !== undefined) p.strength = clean(b.strength, 30);
    if (b.defaultSig !== undefined) p.defaultSig = clean(b.defaultSig, 200); if (typeof b.coldChain === 'boolean') p.coldChain = b.coldChain;
    if (b.reorderLevel !== undefined) { const r = anInt(b.reorderLevel, 0, 1000000, null); if (r === null) return fail(res, 400, 'Enter a valid reorder level.'); p.reorderLevel = r; }
    if (b.cost !== undefined) { const cc = parsePrice(b.cost); if (cc === null) return fail(res, 400, 'Enter a valid cost.'); p.costCents = cc; }
    if (typeof b.controlled === 'boolean') { p.controlled = b.controlled; if (b.controlled) { p.rx = true; p.otc = false; } }
    if (typeof b.rx === 'boolean') { p.rx = b.rx || p.controlled; p.otc = !p.rx; }
    dirty(); res.json({ success: true, product: productView(p) });
});

// ---- public storefront (patients browse OTC by the pharmacy's short code) ----
router.get('/shop/:code', (req, res) => { const f = facilityByCode(req.params.code); if (!f) return fail(res, 404, 'Pharmacy not found.'); res.json({ success: true, pharmacy: { code: f.code, name: f.name, type: f.type, county: f.county, verified: !!f.verified }, products: products(f.id).filter(p => p.stock > 0).map(productView) }); });
router.post('/shop/:code/orders', (req, res) => {
    const f = facilityByCode(req.params.code); if (!f) return fail(res, 404, 'Pharmacy not found.');
    if (limited('order:' + ipOf(req), 20, 3600000)) return slow(res);
    const b = req.body || {}, phone = D.normalizePhone ? D.normalizePhone(String(b.phone || '')) : String(b.phone || '');
    if (!/^\+\d{9,15}$/.test(phone)) return fail(res, 400, 'Enter a valid phone number.');
    const patientName = clean(b.patientName, 60), address = clean(b.address, 200); if (address.length < 5) return fail(res, 400, 'Enter the delivery address.');
    const items = Array.isArray(b.items) ? b.items : []; if (!items.length) return fail(res, 400, 'Add at least one item.');
    const lines = []; let itemsC = 0, anyRx = false, anyControlled = false;
    for (const it of items) {
        const p = S.products[it && it.productId], qty = anInt(it && it.qty, 1, 99, 0);
        if (!p || p.facilityId !== f.id || p.retired || !qty) return fail(res, 400, 'One of the items is not available.');
        if (p.stock < qty) return fail(res, 409, `${p.name}: only ${p.stock} in stock.`);
        if (p.rx) anyRx = true; if (p.controlled) anyControlled = true;
        const lc = p.priceCents * qty; itemsC += lc; lines.push({ productId: p.id, name: p.name, strength: p.strength, form: p.form, qty, priceCents: p.priceCents, lineCents: lc, sig: p.defaultSig || '', labelRef: null, rx: !!p.rx, controlled: !!p.controlled });
    }
    let rxRec = null;
    if (anyRx) { const img = rxImage(b.rxImage); if (!img) return fail(res, 400, 'One or more items need a prescription. Attach a clear photo of the prescription (JPG or PNG).'); rxRec = { status: 'PENDING', image: img, uploadedAt: now(), prescriber: clean(b.prescriber, 80) || null }; }
    const feeC = DELIVERY_FEE_CENTS(), totalC = itemsC + feeC, id = newId('O'), ref = oref(f), t = now(), startStatus = anyRx ? 'PENDING_RX' : 'PLACED';
    const o = { id, ref, facilityId: f.id, phone, patientName, address, geo: (b.lat && b.lng) ? { lat: Number(b.lat), lng: Number(b.lng) } : null, lines, itemsCents: itemsC, deliveryCents: feeC, totalCents: totalC, status: startStatus, createdAt: t, events: [{ at: t, status: startStatus }], paid: false, rider: null, rx: rxRec, idRequired: anyControlled };
    S.orders.push(o); if (S.orders.length > 200000) S.orders.splice(0, S.orders.length - 200000);
    if (D.appendAudit) D.appendAudit('PHARMACY_ORDER_PLACED', { ref, facilityId: f.id, total: kes(totalC) });
    dirty(); res.json({ success: true, order: orderView(o, 'patient'), message: anyRx ? `Order ${ref} received. A pharmacist must verify your prescription before it is prepared. Track it with your phone number.` : `Order ${ref} placed. Pay KES ${kes(totalC)} on delivery or via M-Pesa. Track it with your phone number.` });
});
router.get('/shop/orders/:ref', (req, res) => { const o = S.orders.find(x => x.ref === req.params.ref), phone = D.normalizePhone ? D.normalizePhone(String(req.query.phone || '')) : String(req.query.phone || ''); if (!o || o.phone !== phone) return fail(res, 404, 'Order not found. Check the reference and the phone number used to order.'); res.json({ success: true, order: orderView(o, 'patient') }); });

// ---- pharmacy order queue: confirm -> dispense (auto-label) -> ready -> (rider) ----
router.get('/facilities/:fid/orders', auth, (req, res) => { const m = inFacility(req, res); if (!m) return; res.json({ success: true, orders: S.orders.filter(o => o.facilityId === m.f.id).slice(-200).reverse().map(o => orderView(o, 'staff')) }); });
router.post('/facilities/:fid/orders/:ref', auth, (req, res) => {
    const m = inFacility(req, res); if (!m) return; const o = S.orders.find(x => x.ref === req.params.ref && x.facilityId === m.f.id); if (!o) return fail(res, 404, 'Order not found.');
    const b = req.body || {}, act = String(b.action || ''), advance = (st) => { o.status = st; o.events.push({ at: now(), status: st, by: req.st.id }); };
    if (act === 'verifyrx') {
        if (o.status !== 'PENDING_RX' || !o.rx) return fail(res, 409, 'This order has no prescription waiting for verification.');
        if (b.approve === true) { o.rx.status = 'VERIFIED'; o.rx.verifiedBy = req.st.id; o.rx.verifiedAt = now(); advance('PLACED'); if (D.appendAudit) D.appendAudit('PHARMACY_RX_VERIFIED', { ref: o.ref, facilityId: m.f.id, by: req.st.id }); dirty(); return res.json({ success: true, order: orderView(o, 'staff') }); }
        const reason = clean(b.reason, 200); if (reason.length < 3) return fail(res, 400, 'Give a reason for rejecting the prescription.');
        o.rx.status = 'REJECTED'; o.rx.reason = reason; o.rx.verifiedBy = req.st.id; o.rx.verifiedAt = now(); advance('CANCELLED');
        if (D.appendAudit) D.appendAudit('PHARMACY_RX_REJECTED', { ref: o.ref, facilityId: m.f.id, by: req.st.id }); dirty(); return res.json({ success: true, order: orderView(o, 'staff') });
    }
    if (act === 'confirm') {
        if (o.status !== 'PLACED') return fail(res, 409, `This order is ${o.status.toLowerCase().replace(/_/g, ' ')}.`);
        if (o.rx && o.rx.status !== 'VERIFIED') return fail(res, 409, 'The prescription must be verified before this order can be prepared.');
        for (const l of o.lines) { const p = S.products[l.productId]; if (!p || p.retired) return fail(res, 409, `${l.name} is no longer stocked.`); if (p.stock < l.qty) return fail(res, 409, `${l.name}: only ${p.stock} left.`); }
        for (const l of o.lines) { const p = S.products[l.productId]; if (p) p.stock -= l.qty; }
        advance('CONFIRMED');
    } else if (act === 'dispense') {
        if (o.status !== 'CONFIRMED') return fail(res, 409, 'Confirm the order first.');
        const labels = [];
        for (const l of o.lines) {
            const sig = clean((b.sigs && b.sigs[l.productId]) || l.sig, 200); l.sig = sig; if (!sig) { labels.push({ line: l.name, noSig: true }); continue; }
            const a = analyze(sig);
            if (a.confidence === 'HIGH' && !a.warnings.length) {
                const ref = nextRef(m.f); l.labelRef = ref;
                S.labels.push({ id: newId('L'), ref, facilityId: m.f.id, by: req.st.id, at: now(), category: a.category, detected: a.category, confidence: 'HIGH', overridden: false, textHash: sha(m.f.id + '|' + sig), textLength: sig.length, warnings: [], viaPharmacy: o.ref });
                if (D.appendAudit) D.appendAudit('DOSECOLOR_LABEL', { ref, facilityId: m.f.id, category: a.category, viaPharmacy: o.ref });
                labels.push({ ref, line: l.name, category: catView(a.category), slots: a.slots, durationDays: a.durationDays, maxPerDay: a.maxPerDay, sig });
            } else labels.push({ line: l.name, needsCheck: true, sig, confidence: a.confidence, warnings: a.warnings });
        }
        advance('DISPENSED'); dirty(); return res.json({ success: true, order: orderView(o, 'staff'), labels });
    } else if (act === 'ready') {
        if (o.status !== 'DISPENSED') return fail(res, 409, 'Dispense the order first.');
        advance('READY_FOR_DELIVERY');
        try {
            if (D.dispatchPharmacy) {
                const f = S.facilities[o.facilityId] || {};
                const r = D.dispatchPharmacy({ ref: o.ref, facility: { name: f.name, code: f.code, county: f.county, geo: f.geo || null },
                    patient: { name: o.patientName, phone: o.phone, address: o.address, geo: o.geo },
                    deliveryCents: o.deliveryCents, itemsCount: o.lines.reduce((s, l) => s + l.qty, 0), idRequired: !!o.idRequired,
                    coldChain: o.lines.some(l => { const p = S.products[l.productId]; return p && p.coldChain; }) });
                if (r && r.dispatchPin) { o.deliveryPin = r.dispatchPin; o.events.push({ at: now(), status: 'RIDER_CALLED' }); }
            }
        } catch (e) { /* if dispatch fails the order stays READY; the pharmacy can retry or self-deliver */ }
    }
    else if (act === 'markpaid') { o.paid = true; o.events.push({ at: now(), status: 'PAID', by: req.st.id }); }
    else if (act === 'cancel') { if (o.status === 'DELIVERED') return fail(res, 409, 'This order was already delivered.'); if (['CONFIRMED', 'DISPENSED', 'READY_FOR_DELIVERY'].includes(o.status)) for (const l of o.lines) { const p = S.products[l.productId]; if (p) p.stock += l.qty; } advance('CANCELLED'); }
    else return fail(res, 400, 'action must be verifyrx, confirm, dispense, ready, markpaid or cancel.');
    if (D.appendAudit) D.appendAudit('PHARMACY_ORDER_' + act.toUpperCase(), { ref: o.ref, facilityId: m.f.id, by: req.st.id });
    dirty(); res.json({ success: true, order: orderView(o, 'staff') });
});

// ============================================================================
// 9. PROCUREMENT  (suppliers + purchase orders + goods received with batch / expiry)
//    Lets a pharmacy ORDER stock from suppliers and track what was received, with batch numbers and expiry dates.
// ============================================================================
const supplierView = (s) => ({ id: s.id, name: s.name, phone: s.phone || '', email: s.email || '', note: s.note || '', createdAt: s.createdAt });
const expiryNorm = (v) => { const s = String(v || '').trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; if (/^\d{4}-\d{2}$/.test(s)) return s + '-01'; return null; };
const suppliers = (fid) => Object.values(S.suppliers).filter(s => s.facilityId === fid && !s.retired);
router.post('/facilities/:fid/suppliers', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const b = req.body || {};
    const name = clean(b.name, 80); if (name.length < 2) return fail(res, 400, 'Enter the supplier name.');
    if (suppliers(m.f.id).length >= 2000) return fail(res, 400, 'Supplier list is full.');
    const phone = b.phone ? (D.normalizePhone ? D.normalizePhone(String(b.phone)) : String(b.phone)) : '';
    const id = newId('S');
    S.suppliers[id] = { id, facilityId: m.f.id, name, phone: /^\+\d{9,15}$/.test(phone) ? phone : clean(b.phone, 20), email: clean(b.email, 80), note: clean(b.note, 200), createdAt: now(), retired: false };
    if (D.appendAudit) D.appendAudit('PHARMACY_SUPPLIER_ADDED', { facilityId: m.f.id, supplierId: id, by: req.st.id });
    dirty(); res.json({ success: true, supplier: supplierView(S.suppliers[id]) });
});
router.get('/facilities/:fid/suppliers', auth, (req, res) => { const m = inFacility(req, res); if (!m) return; res.json({ success: true, suppliers: suppliers(m.f.id).map(supplierView) }); });
router.patch('/facilities/:fid/suppliers/:sid', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const s = S.suppliers[req.params.sid]; if (!s || s.facilityId !== m.f.id) return fail(res, 404, 'Supplier not found.'); const b = req.body || {};
    if (b.retire === true) { s.retired = true; dirty(); return res.json({ success: true }); }
    if (b.name !== undefined) { const n = clean(b.name, 80); if (n.length < 2) return fail(res, 400, 'Enter the supplier name.'); s.name = n; }
    if (b.phone !== undefined) s.phone = clean(b.phone, 20); if (b.email !== undefined) s.email = clean(b.email, 80); if (b.note !== undefined) s.note = clean(b.note, 200);
    dirty(); res.json({ success: true, supplier: supplierView(s) });
});
function poref(f) { S.pseq[f.id] = (S.pseq[f.id] || 0) + 1; return `${f.code}-P${String(S.pseq[f.id]).padStart(5, '0')}`; }
const poView = (po) => ({ ref: po.ref, status: po.status, supplierId: po.supplierId, supplierName: (S.suppliers[po.supplierId] || {}).name || po.supplierName || '', createdAt: po.createdAt, sentAt: po.sentAt || null, receivedAt: po.receivedAt || null,
    lines: po.lines.map(l => ({ productId: l.productId, name: l.name, qty: l.qty, received: l.received || 0, unitCost: kes(l.unitCostCents), lineCost: kes(l.unitCostCents * l.qty), batchNo: l.batchNo || '', expiry: l.expiry || '' })),
    totalCost: kes(po.lines.reduce((s, l) => s + l.unitCostCents * l.qty, 0)), note: po.note || '', events: po.events || [] });
router.post('/facilities/:fid/purchase-orders', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const b = req.body || {};
    const sup = S.suppliers[b.supplierId]; if (!sup || sup.facilityId !== m.f.id || sup.retired) return fail(res, 400, 'Choose a supplier.');
    const items = Array.isArray(b.items) ? b.items : []; if (!items.length) return fail(res, 400, 'Add at least one item.');
    const lines = [];
    for (const it of items) {
        const p = S.products[it && it.productId], qty = anInt(it && it.qty, 1, 1000000, 0); if (!p || p.facilityId !== m.f.id || p.retired || !qty) return fail(res, 400, 'One of the items is not in your catalog.');
        const cost = parsePrice(it.unitCost); if (cost === null) return fail(res, 400, `Enter a unit cost for ${p.name}.`);
        lines.push({ productId: p.id, name: p.name, qty, unitCostCents: cost, received: 0, batchNo: '', expiry: '' });
    }
    if ((S.purchaseOrders || []).length >= 200000) return fail(res, 400, 'Too many purchase orders.');
    const id = newId('PO'), ref = poref(m.f), t = now();
    const po = { id, ref, facilityId: m.f.id, supplierId: sup.id, supplierName: sup.name, lines, status: 'DRAFT', note: clean(b.note, 200), createdAt: t, events: [{ at: t, status: 'DRAFT', by: req.st.id }] };
    S.purchaseOrders.push(po);
    if (D.appendAudit) D.appendAudit('PHARMACY_PO_CREATED', { ref, facilityId: m.f.id, by: req.st.id });
    dirty(); res.json({ success: true, purchaseOrder: poView(po) });
});
router.get('/facilities/:fid/purchase-orders', auth, (req, res) => { const m = inFacility(req, res); if (!m) return; res.json({ success: true, purchaseOrders: (S.purchaseOrders || []).filter(po => po.facilityId === m.f.id).slice(-200).reverse().map(poView) }); });
router.post('/facilities/:fid/purchase-orders/:pref', auth, (req, res) => {
    const m = inFacility(req, res, true); if (!m) return; const po = (S.purchaseOrders || []).find(x => x.ref === req.params.pref && x.facilityId === m.f.id); if (!po) return fail(res, 404, 'Purchase order not found.');
    const b = req.body || {}, act = String(b.action || '');
    if (act === 'send') { if (po.status !== 'DRAFT') return fail(res, 409, 'Only a draft can be sent.'); po.status = 'SENT'; po.sentAt = now(); po.events.push({ at: now(), status: 'SENT', by: req.st.id }); }
    else if (act === 'receive') {
        if (po.status === 'RECEIVED' || po.status === 'CANCELLED') return fail(res, 409, `This purchase order is ${po.status.toLowerCase()}.`);
        const rec = (b.received && typeof b.received === 'object') ? b.received : {}; let any = false;
        for (const l of po.lines) {
            const r = rec[l.productId] || {}, rq = anInt(r.qty, 0, 1000000, l.qty - (l.received || 0));
            if (rq <= 0) continue; const p = S.products[l.productId]; if (!p || p.retired) continue;
            const expiry = expiryNorm(r.expiry), batchNo = clean(r.batchNo, 40);
            if (!p.batches) p.batches = [];
            p.batches.push({ batchNo: batchNo || '-', expiry: expiry || null, qty: rq, at: now(), poRef: po.ref });
            p.stock = (p.stock || 0) + rq; if (p.costCents == null) p.costCents = l.unitCostCents;
            l.received = (l.received || 0) + rq; if (batchNo) l.batchNo = batchNo; if (expiry) l.expiry = expiry; any = true;
        }
        if (!any) return fail(res, 400, 'Enter the quantity received for at least one item.');
        const complete = po.lines.every(l => (l.received || 0) >= l.qty);
        po.status = complete ? 'RECEIVED' : 'PARTIAL'; if (complete) po.receivedAt = now();
        po.events.push({ at: now(), status: po.status, by: req.st.id });
        if (D.appendAudit) D.appendAudit('PHARMACY_PO_RECEIVED', { ref: po.ref, facilityId: m.f.id, by: req.st.id });
        dirty(); return res.json({ success: true, purchaseOrder: poView(po) });
    }
    else if (act === 'cancel') { if (po.status === 'RECEIVED') return fail(res, 409, 'This purchase order was already received.'); po.status = 'CANCELLED'; po.events.push({ at: now(), status: 'CANCELLED', by: req.st.id }); }
    else return fail(res, 400, 'action must be send, receive or cancel.');
    if (D.appendAudit) D.appendAudit('PHARMACY_PO_' + act.toUpperCase(), { ref: po.ref, facilityId: m.f.id, by: req.st.id });
    dirty(); res.json({ success: true, purchaseOrder: poView(po) });
});
router.get('/facilities/:fid/stock-alerts', auth, (req, res) => {
    const m = inFacility(req, res); if (!m) return;
    const today = new Date().toISOString().slice(0, 10), soon = new Date(now() + 90 * 86400000).toISOString().slice(0, 10);
    const low = [], expiring = [], expired = [];
    for (const p of products(m.f.id)) {
        if ((p.reorderLevel || 0) > 0 && (p.stock || 0) <= p.reorderLevel) low.push({ id: p.id, name: p.name, stock: p.stock, reorderLevel: p.reorderLevel });
        for (const bch of (p.batches || [])) { if (!bch.qty || !bch.expiry) continue; if (bch.expiry < today) expired.push({ id: p.id, name: p.name, batchNo: bch.batchNo, expiry: bch.expiry, qty: bch.qty }); else if (bch.expiry <= soon) expiring.push({ id: p.id, name: p.name, batchNo: bch.batchNo, expiry: bch.expiry, qty: bch.qty }); }
    }
    res.json({ success: true, low, expiring, expired });
});

// ---- DELIVERY HANDOFF: the RDS rider network reads READY orders and posts status back ----
// server.js wires these into the same rider dispatch used by food/shop orders (see PHARMACY glue in server).
router.readyDeliveries = () => S.orders.filter(o => o.status === 'READY_FOR_DELIVERY').map(o => { const f = S.facilities[o.facilityId] || {}; return { ref: o.ref, pickup: { name: f.name, code: f.code, county: f.county }, dropoff: { name: o.patientName, phone: o.phone, address: o.address, geo: o.geo }, itemsCount: o.lines.reduce((s, l) => s + l.qty, 0), coldChain: o.lines.some(l => { const p = S.products[l.productId]; return p && p.coldChain; }), idRequired: !!o.idRequired, totalCents: o.totalCents, total: kes(o.totalCents), paid: !!o.paid }; });
router.deliveryUpdate = (ref, status, rider) => { const o = S.orders.find(x => x.ref === ref); if (!o) return { ok: false, error: 'Order not found.' }; const map = { ASSIGNED: 'OUT_FOR_DELIVERY', PICKED: 'OUT_FOR_DELIVERY', OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY', DELIVERED: 'DELIVERED' }, st = map[String(status || '').toUpperCase()]; if (!st) return { ok: false, error: 'Unknown status.' }; if (rider) o.rider = rider; o.status = st; o.events.push({ at: now(), status: String(status).toUpperCase(), rider: rider || null }); if (st === 'DELIVERED') o.paid = true; if (D.appendAudit) D.appendAudit('PHARMACY_DELIVERY_' + st, { ref: o.ref, rider: rider || null }); dirty(); return { ok: true, status: o.status }; };
function pharmacyStats() {
    const t0 = now() - 86400000, O = S.orders.filter(o => o.createdAt >= t0);
    const prods = Object.values(S.products).filter(p => !p.retired);
    const today = new Date().toISOString().slice(0, 10), soon = new Date(now() + 90 * 86400000).toISOString().slice(0, 10);
    const expCount = (test) => prods.reduce((n, p) => n + ((p.batches || []).some(x => x.qty > 0 && x.expiry && test(x.expiry)) ? 1 : 0), 0);
    return { products: prods.length, orders24h: O.length, salesKes24h: kes(O.filter(o => o.status !== 'CANCELLED').reduce((s, o) => s + o.totalCents, 0)), readyForDelivery: S.orders.filter(o => o.status === 'READY_FOR_DELIVERY').length, outForDelivery: S.orders.filter(o => o.status === 'OUT_FOR_DELIVERY').length, deliveredToday: O.filter(o => o.status === 'DELIVERED').length,
        pendingRx: S.orders.filter(o => o.status === 'PENDING_RX').length, lowStock: prods.filter(p => (p.reorderLevel || 0) > 0 && (p.stock || 0) <= p.reorderLevel).length, expiringSoon: expCount(e => e >= today && e <= soon), expired: expCount(e => e < today),
        suppliers: Object.values(S.suppliers || {}).filter(s => !s.retired).length, openPurchaseOrders: (S.purchaseOrders || []).filter(po => po.status === 'DRAFT' || po.status === 'SENT' || po.status === 'PARTIAL').length };
}

router.stats = stats;
router.pharmacyStats = pharmacyStats;
router.analyze = analyze;
router.CATEGORIES = CATEGORIES;
router._test = { state: () => S, reset: () => { S = blank(); hits.clear(); }, flush: () => flushNow(), whenReady: () => readyPromise };
module.exports = router;
module.exports.agent = { loadConfig, extractText, jobKind, bannerBytes, handleJob, start };