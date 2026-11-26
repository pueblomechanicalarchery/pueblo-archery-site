// Public, anonymous summary of the bows on members' gear lists: maker + model with a count,
// split into Target and Hunting. No names, setups or other gear details leave the database.
import { json, ensureSchema } from '../_lib.js';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ target: [], hunting: [] });
  await ensureSchema(env.DB);
  // Which model groups are target bows (from the maintained bow list)
  const targetModels = new Set();
  try {
    const r = await env.ASSETS.fetch(new URL('/data/site.json', request.url));
    const d = await r.json();
    for (const b of (d.gear && d.gear.bows) || [])
      for (const g of b.groups || [])
        if (/target/i.test(g.label || '')) for (const m of g.models || []) targetModels.add((b.brand + ' ' + m).toLowerCase());
  } catch (_) {}
  const { results: act } = await env.DB.prepare("SELECT id FROM members WHERE status='active'").all();
  const live = new Set(act.map(a => a.id));
  const { results } = await env.DB.prepare("SELECT owner, data FROM docs WHERE path LIKE 'data/users/%/bows'").all();
  const tally = { target: new Map(), hunting: new Map() };
  for (const row of results) {
    if (!live.has(row.owner)) continue;
    let items = [];
    try { items = JSON.parse(row.data).items || []; } catch (_) {}
    for (const b of items) {
      const name = clean([b.brand, b.model].filter(Boolean).join(' '));
      if (!name) continue;
      const use = b.use === 'Target' ? ['target'] : b.use === 'Hunting' ? ['hunting'] : b.use === 'Both' ? ['target', 'hunting']
        : [targetModels.has(name.toLowerCase()) ? 'target' : 'hunting'];
      for (const u of use) tally[u].set(name, (tally[u].get(name) || 0) + 1);
    }
  }
  const list = m => [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const res = json({ target: list(tally.target), hunting: list(tally.hunting) });
  res.headers.set('cache-control', 'public, max-age=300');
  return res;
}
