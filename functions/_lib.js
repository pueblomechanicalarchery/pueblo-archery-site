// Shared helpers for the members area (Cloudflare Pages Functions + D1).
// Sign-in is handled by Cloudflare Access (one-time code by email). Every request
// is checked here by verifying the Access token, so the API cannot be reached by
// skipping Access (for example through the .pages.dev address).

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const fail = (status, error) => json({ error }, status);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
     id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
     role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending',
     note TEXT DEFAULT '', created INTEGER, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS docs (
     path TEXT PRIMARY KEY, col TEXT NOT NULL, owner TEXT, data TEXT NOT NULL, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS docs_col ON docs(col)`
];
let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  schemaReady = true;
}

// ---------- Cloudflare Access token check ----------
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
let certCache = { at: 0, keys: [] };
async function accessKeys(team) {
  if (Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs');
  const { keys } = await r.json();
  certCache = { at: Date.now(), keys };
  return keys;
}
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
export async function signedInEmail(req, env) {
  // Local testing only: never active on a real hostname.
  const host = new URL(req.url).hostname;
  if (env.DEV_INSECURE === '1' && (host === 'localhost' || host === '127.0.0.1')) {
    const e = req.headers.get('x-dev-email') || cookie(req, 'dev_email');
    return e ? e.toLowerCase() : null;
  }
  const team = (env.ACCESS_TEAM || '').trim(), aud = (env.ACCESS_AUD || '').trim();
  if (!team || !aud) return null;
  const token = req.headers.get('cf-access-jwt-assertion') || cookie(req, 'CF_Authorization');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64url(h))); payload = JSON.parse(new TextDecoder().decode(b64url(p))); } catch { return null; }
  const keys = await accessKeys(team);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) return null;
  const now = Date.now() / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud) || (payload.exp && payload.exp < now) || (payload.nbf && payload.nbf > now + 60)) return null;
  if (payload.iss && payload.iss !== `https://${team}.cloudflareaccess.com`) return null;
  return payload.email ? String(payload.email).toLowerCase() : null;
}

// ---------- Members ----------
const ownerEmails = env => (env.OWNER_EMAIL || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
export const newId = () => 'm' + crypto.randomUUID().replace(/-/g, '').slice(0, 15);

// Returns the member row for the signed-in email (creating nothing), with owners auto-activated.
export async function currentMember(db, env, email) {
  let m = await db.prepare('SELECT * FROM members WHERE email = ?').bind(email).first();
  if (ownerEmails(env).includes(email)) {
    if (!m) {
      m = { id: newId(), email, name: '', role: 'owner', status: 'active', note: '', created: Date.now(), updated: Date.now() };
      await db.prepare('INSERT INTO members (id,email,name,role,status,note,created,updated) VALUES (?,?,?,?,?,?,?,?)')
        .bind(m.id, m.email, m.name, m.role, m.status, m.note, m.created, m.updated).run();
    } else if (m.role !== 'owner' || m.status !== 'active') {
      await db.prepare("UPDATE members SET role='owner', status='active', updated=? WHERE id=?").bind(Date.now(), m.id).run();
      m.role = 'owner'; m.status = 'active';
    }
  } else if (m && m.status === 'invited') {
    // Invited by an admin: first sign-in activates them.
    await db.prepare("UPDATE members SET status='active', updated=? WHERE id=?").bind(Date.now(), m.id).run();
    m.status = 'active';
  }
  return m;
}
export const isActive = m => !!m && m.status === 'active';
export const isAdmin = m => isActive(m) && (m.role === 'admin' || m.role === 'owner');
export const isOwner = m => isActive(m) && m.role === 'owner';
