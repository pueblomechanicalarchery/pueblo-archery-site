// Members API. All routes need a signed-in email (Cloudflare Access); most need an active member.
import { json, fail, ensureSchema, signedInEmail, currentMember, isActive, isAdmin, isOwner, newId } from '../_lib.js';

const PER_MEMBER = ['roster', 'teamgear', 'rsvp', 'results'];
const TEAM_DOCS = ['ann', 'sponsors', 'youth'];
const MY_DOCS = ['bows', 'arrows', 'rounds', 'prefs', 'family'];
const MAX_DOC = 256 * 1024;
const cleanEmail = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const clip = (s, n) => String(s || '').trim().slice(0, n);

// Who may read or write a document path.
function rule(path, m) {
  const s = path.split('/');
  if (s.some(x => !x || !/^[A-Za-z0-9_-]{1,80}$/.test(x))) return null;
  if (s.length === 2 && s[0] === 'config' && s[1] === 'roles') return { read: true, write: false, synth: 'roles' };
  if (s.length === 2 && PER_MEMBER.includes(s[0])) return { read: true, write: s[1] === m.id, owner: s[1] };
  if (s.length === 2 && s[0] === 'team' && TEAM_DOCS.includes(s[1])) return { read: true, write: isAdmin(m) };
  if (s.length === 4 && s[0] === 'data' && s[1] === 'users' && MY_DOCS.includes(s[3])) { const mine = s[2] === m.id; return { read: mine, write: mine, owner: s[2] }; }
  return null;
}

async function rolesDoc(db) {
  const { results } = await db.prepare("SELECT id FROM members WHERE status='active' AND role='admin'").all();
  return { admins: results.map(r => r.id) };
}
async function activeIds(db) {
  const { results } = await db.prepare("SELECT id FROM members WHERE status='active'").all();
  return new Set(results.map(r => r.id));
}

export async function onRequest({ request, env, params }) {
  if (!env.DB) return fail(503, 'Members database is not connected yet.');
  const db = env.DB;
  await ensureSchema(db);
  const email = await signedInEmail(request, env).catch(() => null);
  if (!email) return json({ signedIn: false }, 401);

  const route = (params.path || []).join('/');
  const url = new URL(request.url);
  const method = request.method;
  const body = ['POST', 'PUT'].includes(method) ? await request.json().catch(() => ({})) : {};
  const m = await currentMember(db, env, email);

  if (route === 'me' && method === 'GET') {
    return json({ signedIn: true, email, member: m ? { id: m.id, name: m.name, role: m.role, status: m.status } : null });
  }

  if (route === 'join' && method === 'POST') {
    const name = clip(body.name, 80), note = clip(body.note, 300);
    if (!name) return fail(400, 'Please enter your name.');
    if (isActive(m)) return json({ ok: true, status: 'active' });
    const now = Date.now();
    if (m) await db.prepare("UPDATE members SET name=?, note=?, status='pending', updated=? WHERE id=?").bind(name, note, now, m.id).run();
    else await db.prepare("INSERT INTO members (id,email,name,role,status,note,created,updated) VALUES (?,?,?,'member','pending',?,?,?)").bind(newId(), email, name, note, now, now).run();
    return json({ ok: true, status: 'pending' });
  }

  if (!isActive(m)) return fail(403, 'Not an active team member.');

  if (route === 'doc') {
    const path = url.searchParams.get('path') || '';
    const r = rule(path, m);
    if (!r) return fail(404, 'Unknown record.');
    if (method === 'GET') {
      if (!r.read) return fail(403, 'Not allowed.');
      if (r.synth === 'roles') return json({ exists: true, data: await rolesDoc(db) });
      const row = await db.prepare('SELECT data, updated FROM docs WHERE path=?').bind(path).first();
      return json(row ? { exists: true, data: JSON.parse(row.data), updated: row.updated } : { exists: false });
    }
    if (!r.write) return fail(403, 'Not allowed.');
    if (method === 'DELETE') { await db.prepare('DELETE FROM docs WHERE path=?').bind(path).run(); return json({ ok: true }); }
    if (method === 'PUT') {
      let data = body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'Bad record.');
      if (body.merge) {
        const row = await db.prepare('SELECT data FROM docs WHERE path=?').bind(path).first();
        data = { ...(row ? JSON.parse(row.data) : {}), ...data };
      }
      const text = JSON.stringify(data);
      if (text.length > MAX_DOC) return fail(413, 'That record is too large.');
      const col = path.split('/').slice(0, -1).join('/');
      await db.prepare('INSERT INTO docs (path,col,owner,data,updated) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated')
        .bind(path, col, r.owner || null, text, Date.now()).run();
      if (col === 'roster' && typeof data.name === 'string' && data.name.trim()) await db.prepare('UPDATE members SET name=?, updated=? WHERE id=?').bind(clip(data.name, 80), Date.now(), m.id).run();
      return json({ ok: true });
    }
    return fail(405, 'Method not allowed.');
  }

  if (route === 'col' && method === 'GET') {
    const col = url.searchParams.get('path') || '';
    if (![...PER_MEMBER, 'team'].includes(col)) return fail(404, 'Unknown list.');
    const { results } = await db.prepare('SELECT path, data FROM docs WHERE col=?').bind(col).all();
    const live = PER_MEMBER.includes(col) ? await activeIds(db) : null;
    const docs = results.map(r => ({ id: r.path.split('/').pop(), data: JSON.parse(r.data) }))
      .filter(d => !live || live.has(d.id));
    return json({ docs });
  }

  if (route === 'profiles' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 100);
    const out = {};
    if (ids.length) {
      const { results } = await db.prepare(`SELECT id, name FROM members WHERE status='active' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      for (const r of results) out[r.id] = { name: r.name || '' };
    }
    return json(out);
  }

  // ----- Admin: membership -----
  if (route === 'admin/members') {
    if (!isAdmin(m)) return fail(403, 'Admins only.');
    if (method === 'GET') {
      const { results } = await db.prepare("SELECT id,email,name,role,status,note,created FROM members WHERE status IN ('active','pending','invited') ORDER BY status, name").all();
      return json({ members: results });
    }
    if (method === 'POST') {
      const a = body.action, now = Date.now();
      if (a === 'invite') {
        const e = cleanEmail(body.email), name = clip(body.name, 80);
        if (!okEmail(e)) return fail(400, 'Enter a valid email address.');
        const ex = await db.prepare('SELECT * FROM members WHERE email=?').bind(e).first();
        if (ex && ex.status === 'active') return fail(400, 'That person is already a member.');
        if (ex) await db.prepare("UPDATE members SET status='invited', name=COALESCE(NULLIF(?,''),name), updated=? WHERE id=?").bind(name, now, ex.id).run();
        else await db.prepare("INSERT INTO members (id,email,name,role,status,note,created,updated) VALUES (?,?,?,'member','invited','',?,?)").bind(newId(), e, name, now, now).run();
        return json({ ok: true });
      }
      const t = await db.prepare('SELECT * FROM members WHERE id=?').bind(String(body.id || '')).first();
      if (!t) return fail(404, 'Member not found.');
      if (t.role === 'owner') return fail(403, 'The site owner can’t be changed here.');
      if (a === 'approve') { await db.prepare("UPDATE members SET status='active', updated=? WHERE id=?").bind(now, t.id).run(); return json({ ok: true }); }
      if (a === 'decline' || a === 'remove') { await db.prepare("UPDATE members SET status='removed', role='member', updated=? WHERE id=?").bind(now, t.id).run(); return json({ ok: true }); }
      if (a === 'rename') { const name = clip(body.name, 80); if (!name) return fail(400, 'Enter a name.'); await db.prepare('UPDATE members SET name=?, updated=? WHERE id=?').bind(name, now, t.id).run(); return json({ ok: true }); }
      if (a === 'admin' || a === 'unadmin') {
        if (!isOwner(m)) return fail(403, 'Only the site owner can change admins.');
        if (t.status !== 'active') return fail(400, 'Approve them as a member first.');
        await db.prepare('UPDATE members SET role=?, updated=? WHERE id=?').bind(a === 'admin' ? 'admin' : 'member', now, t.id).run();
        return json({ ok: true });
      }
      return fail(400, 'Unknown action.');
    }
  }

  return fail(404, 'Not found.');
}
