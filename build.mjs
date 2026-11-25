// Builds the public site into dist/ for Cloudflare Pages.
// Merges the editable content/ files into dist/data/site.json, which the page loads.
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync('site', out, { recursive: true });
if (fs.existsSync('images')) fs.cpSync('images', path.join(out, 'images'), { recursive: true });

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { if (fs.existsSync(f)) console.warn(`Skipping ${f}: ${e.message}`); return fallback; }
};
const folder = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
      .map(f => { const d = readJson(path.join(dir, f), null); return d && typeof d === 'object' ? { id: path.basename(f, '.json'), ...d } : null; })
      .filter(Boolean)
  : [];

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const events = folder('content/events').map(e => {
  for (const k of Object.keys(e)) if (e[k] === '' || e[k] === null) delete e[k];
  return e;
}).filter(e => {
  if (!e.t || !isDate(e.s)) { console.warn(`Event ${e.id} is missing a title or start date; left off the calendar.`); return false; }
  return true;
});
const tac = readJson('content/tac.json', []);
const gallery = folder('content/gallery');
const webcheck = readJson('content/settings/webcheck.json', {});

fs.mkdirSync(path.join(out, 'data'), { recursive: true });
fs.writeFileSync(path.join(out, 'data', 'site.json'), JSON.stringify({ built: new Date().toISOString(), events, tac, gallery, webcheck }));
console.log(`Built: ${events.length} events, ${tac.length} TAC stops, ${gallery.length} photo posts.`);
