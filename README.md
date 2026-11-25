# Pueblo Mechanical Archery Team — website

The public team site, hosted on Cloudflare Pages. Every change pushed to `main` goes live in about a minute.

## Where things live

| What | Where | Edit with |
|---|---|---|
| Calendar events (one file per event) | `content/events/` | Pages CMS → **Calendar events** |
| Team photos | `content/gallery/` + `images/gallery/` | Pages CMS → **Photo gallery** |
| Total Archery Challenge stops | `content/tac.json` | Pages CMS → **Total Archery Challenge stops** |
| Weekly web-check note | `content/settings/webcheck.json` | Written by the weekly calendar check |
| Page design, text and code | `site/index.html` | Changes made with Claude |

## Cloudflare Pages build settings

- Framework preset: **None**
- Build command: `node build.mjs`
- Build output directory: `dist`

`build.mjs` copies `site/` and `images/` into `dist/` and merges the `content/` files into `dist/data/site.json`, which the page reads.

## Editing from a phone

Sign in at https://app.pagescms.org with GitHub (or the email invite), open this repository, and pick a section. Saving commits to GitHub and the site rebuilds itself.

## Notes

- Built-in event file names (like `umac2.json`) are the event IDs that members' series checklists use — rename them only if you have to.
- Events the weekly check finds are added with "Added by: Weekly web check" and show a "Found online · verify" tag until someone ticks **Checked by a team member**.
- The members area (sign-in, gear, rounds, results) is planned as the next phase.
