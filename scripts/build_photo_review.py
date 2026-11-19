"""Build the species photo-and-description review page.

    py scripts/build_photo_review.py        # -> review/public/index.html

The photos in `data/images/<slug>.json` are auto-picked from iNaturalist
(`scripts/pull_species_images.py`) and the descriptions in
`data/descriptions/<slug>.md` are project-written, not yet expert-reviewed
(see that directory's README). Per species, the page shows every candidate
photo (mark keep/reject, or flag the whole species as "none of these are
right") and an editable text box seeded with the current description.

Each species also has an "Included in the app" switch. The page lists every
candidate species (`candidate_species()`), including the ones the curated scope
in `data/species_scope.json` currently leaves out, so a species can be switched
back on. A changed switch is saved with the rest of the review state under
`scope`; `scripts/apply_review_scope.py` turns those choices into the scope
file, and the app follows on the next deploy.

This page is deployed as its own small Cloudflare Pages project
(`review/`, see `review/wrangler.toml`), separate from the main app, so it
can't affect the real site's build/deploy. Review state (keep/reject, edited
descriptions) is read and written through `review/functions/api/
review-state.js`, a Pages Function backed by a Workers KV namespace -- real,
live, shared state, reachable by anyone with the link, no Claude account
needed.

That specific design -- a plain Cloudflare Worker/KV pair instead of a
Claude Artifact's `artifact`/`db` runtime capabilities -- exists because
those capabilities were tried first and confirmed not to work for this: any
page that declares one requires the viewer to be signed in to a Claude
account in the owner's organization, even when the artifact's own share
setting is "anyone with the link" (confirmed by testing a capability probe
both logged out and, to isolate the variable properly, with sharing
explicitly opened up first). A mycologist with no Claude account can open
such a page but every capability call resolves null for them, so nothing
they do would ever save. Cloudflare KV has no such restriction.

Unlike the artifact version of this page, photos are hotlinked directly to
iNaturalist (`_medium_url` swaps in the smaller `medium` size, plenty for a
260px thumbnail) rather than downloaded and republished -- that workaround
was only needed for the Claude Artifact sandbox's CSP, which does not apply
to a normal, independently-hosted web page.
"""

from __future__ import annotations

import html
import json
import re

from pipeline.config import DESCRIPTIONS_DIR, IMAGES_DIR, REPO_ROOT
from pipeline.publish.site import slugify
from pipeline.species import candidate_species, excluded_slugs

OUT = REPO_ROOT / "review" / "public" / "index.html"

# Keep in sync with TOKEN in review/functions/api/review-state.js -- not a
# real secret (it ships in this page's own client-side JS either way), just
# enough to keep the endpoint from being hit by crawlers/scanners.
API_TOKEN = "5d1ebe80f5e64c4d61380df93c29c74d"


def _medium_url(url: str) -> str:
    return re.sub(r"/(square|small|medium|large|original)\.", "/medium.", url)


STYLE = """
:root { color-scheme: light dark; --bg:#f4f3ee; --fg:#232620; --muted:#6c6f61;
  --card:#fff; --border:#dcdacd; --keep:#2f7d32; --reject:#b23b3b; --accent:#b26b18; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#1a1c17; --fg:#e8e6da; --muted:#9a9c8c; --card:#232620; --border:#363a2e; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header { position:sticky; top:0; z-index:5; background:var(--card);
  border-bottom:1px solid var(--border);
  padding:.6rem 1rem; display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
header h1 { font-size:1rem; margin:0 .5rem 0 0; }
header button, header select { font:inherit; padding:.3rem .6rem; border:1px solid var(--border);
  border-radius:6px; background:var(--bg); color:var(--fg); cursor:pointer; }
.count { color:var(--muted); }
.syncstate { font-size:.8rem; padding:.15rem .5rem; border-radius:999px;
  border:1px solid var(--border); }
.syncstate[data-state="saving"], .syncstate[data-state="loading"] { color:var(--accent);
  border-color:var(--accent); }
.syncstate[data-state="synced"] { color:var(--keep); border-color:var(--keep); }
.syncstate[data-state="error"] { color:var(--reject); border-color:var(--reject); }
main { padding:1rem; display:grid; gap:1rem; max-width:1100px; margin:0 auto; }
.howto { max-width:1100px; margin:1rem auto 0; padding:.7rem 1rem; border-radius:6px;
  background:var(--card); border:1px solid var(--border); font-size:.88rem; color:var(--muted); }
.sp { background:var(--card); border:1px solid var(--border); border-left:5px solid var(--border);
  border-radius:8px; padding:.8rem 1rem; }
.sp[data-state="done"] { border-left-color:var(--keep); }
.sp[data-state="attention"] { border-left-color:var(--reject); }
.sp h2 { margin:0; font-size:1rem; }
.sp .sci { color:var(--muted); font-style:italic; font-weight:normal; }
.sp .meta { color:var(--muted); font-size:.85rem; margin:.15rem 0 .5rem; }
.shots { display:flex; gap:.8rem; flex-wrap:wrap; margin-bottom:.7rem; }
.shot { width:260px; border:1px solid var(--border); border-radius:6px;
  overflow:hidden; background:var(--bg); }
.shot img { display:block; width:100%; height:190px; object-fit:cover; background:#0002; }
.shot .cap { padding:.35rem .5rem; font-size:.78rem; color:var(--muted); }
.shot .cap a { color:var(--accent); }
.shot .btns { display:flex; }
.shot .btns button { flex:1; border:0; border-top:1px solid var(--border); padding:.4rem;
  background:var(--bg); color:var(--fg); cursor:pointer; font:inherit; }
.shot .btns button + button { border-left:1px solid var(--border); }
.shot[data-v="keep"] { outline:2px solid var(--keep); }
.shot[data-v="reject"] { outline:2px solid var(--reject); opacity:.55; }
.shot[data-v="keep"] .btns .k, .shot[data-v="reject"] .btns .r { font-weight:700; }
.none { margin:.3rem 0 .7rem; display:block; }
.none.on { color:var(--reject); font-weight:700; }
.empty { color:var(--reject); font-weight:600; }
.desc label { display:block; font-size:.78rem; color:var(--muted); margin-bottom:.25rem;
  text-transform:uppercase; letter-spacing:.04em; }
.desc textarea { width:100%; min-height:7rem; font:inherit; padding:.55rem .65rem;
  border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg);
  resize:vertical; }
.desc textarea:focus { outline:2px solid var(--accent); outline-offset:1px; }
.desc textarea:disabled { opacity:.6; }
.desc .edited { color:var(--accent); font-size:.78rem; margin-top:.25rem; }
.sp .head { display:flex; gap:.75rem; align-items:flex-start; justify-content:space-between;
  flex-wrap:wrap; }
.scope { display:inline-flex; align-items:center; gap:.4rem; padding:.3rem .65rem;
  border:1px solid var(--keep); border-radius:999px; color:var(--keep); font-weight:600;
  cursor:pointer; white-space:nowrap; }
.scope input { accent-color:var(--keep); margin:0; }
.scope .changed { font-weight:normal; font-size:.78rem; }
.sp[data-scope="exclude"] .scope { border-color:var(--reject); color:var(--reject); }
.sp[data-scope="exclude"] { border-left-color:var(--muted); }
.sp[data-scope="exclude"] h2, .sp[data-scope="exclude"] .shots,
.sp[data-scope="exclude"] .desc { opacity:.5; }
"""

SCRIPT = """
const API = "/api/review-state";
const TOKEN = "%TOKEN%";
let state = { review: {}, descriptions: {}, scope: {} };
let loaded = false;

function setSyncState(s) {
  const el = document.getElementById("syncstate");
  if (!el) return;
  const label = {
    loading: "Loading…", saving: "Saving…", synced: "Saved",
    error: "Save failed — will retry on next change",
  }[s] || "";
  el.textContent = label;
  el.dataset.state = s;
}

async function loadState() {
  setSyncState("loading");
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") state = data;
    }
  } catch {}
  if (!state.review) state.review = {};
  if (!state.descriptions) state.descriptions = {};
  if (!state.scope) state.scope = {};
  loaded = true;
  document.querySelectorAll(".desc textarea, .scope input").forEach(el => el.disabled = false);
  initDescriptions();
  render();
  setSyncState("synced");
}

let saveTimer = null;
function scheduleSave(immediate) {
  if (saveTimer) clearTimeout(saveTimer);
  if (immediate) { doSave(); return; }
  saveTimer = setTimeout(doSave, 900);
}
async function doSave() {
  setSyncState("saving");
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": TOKEN },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error(String(res.status));
    setSyncState("synced");
  } catch {
    setSyncState("error");
  }
}

function setShot(id, v) {
  if (!loaded) return;
  if (state.review[id] === v) delete state.review[id]; else state.review[id] = v;
  render(); scheduleSave(true);
}
function setNone(slug, on) {
  if (!loaded) return;
  if (on) state.review["none:" + slug] = 1; else delete state.review["none:" + slug];
  render(); scheduleSave(true);
}
function setDescription(slug, original, text) {
  if (!loaded) return;
  if (text === original) delete state.descriptions[slug]; else state.descriptions[slug] = text;
  render(); scheduleSave(false); // debounced -- don't POST on every keystroke
}

// Only a choice that differs from what the app has today is stored, so the
// saved state is exactly the list of changes still to be applied.
function setScope(slug, baseline, included) {
  if (!loaded) return;
  const choice = included ? "include" : "exclude";
  if (choice === baseline) delete state.scope[slug]; else state.scope[slug] = choice;
  render(); scheduleSave(true);
}

function render() {
  let keep = 0, reject = 0, none = 0, decided = 0, total = 0, species = 0, included = 0;
  document.querySelectorAll(".shot").forEach(el => {
    total++;
    const v = state.review[el.dataset.id] || "";
    el.dataset.v = v;
    if (v) decided++;
    if (v === "keep") keep++;
    if (v === "reject") reject++;
  });
  document.querySelectorAll(".sp").forEach(sp => {
    const slug = sp.dataset.slug;
    const scope = state.scope[slug] || sp.dataset.baseline;
    sp.dataset.scope = scope;
    species++;
    if (scope === "include") included++;
    const box = sp.querySelector(".scope input");
    if (box) box.checked = scope === "include";
    const scopeText = sp.querySelector(".scope .label");
    if (scopeText) scopeText.textContent =
      scope === "include" ? "Included in the app" : "Excluded from the app";
    const changedEl = sp.querySelector(".scope .changed");
    if (changedEl) changedEl.hidden = !(slug in state.scope);
    const noneOn = !!state.review["none:" + slug];
    sp.querySelector(".none")?.classList.toggle("on", noneOn);
    const shots = [...sp.querySelectorAll(".shot")];
    const allDecided = shots.length > 0 && shots.every(s => state.review[s.dataset.id]);
    const anyReject = shots.some(s => state.review[s.dataset.id] === "reject");
    sp.dataset.state = (noneOn || anyReject) ? "attention"
      : (allDecided || shots.length === 0) ? "done" : "";
    if (noneOn) none++;
    const editedEl = sp.querySelector(".edited");
    if (editedEl) editedEl.hidden = !(slug in state.descriptions);
  });
  document.getElementById("count").textContent =
    `${included} of ${species} species in the app`
    + ` (${Object.keys(state.scope).length} changed) · `
    + `${decided}/${total} photos decided · ${keep} keep · ${reject} reject`
    + ` · ${none} species flagged · ${Object.keys(state.descriptions).length} descriptions edited`;
}
function initDescriptions() {
  document.querySelectorAll(".desc textarea").forEach(ta => {
    const slug = ta.dataset.slug;
    if (slug in state.descriptions) ta.value = state.descriptions[slug];
  });
}
function filter(mode) {
  document.querySelectorAll(".sp").forEach(sp => {
    const st = sp.dataset.state;
    sp.hidden = (mode === "attention" && st !== "attention")
      || (mode === "undecided" && st === "done")
      || (mode === "included" && sp.dataset.scope !== "include")
      || (mode === "excluded" && sp.dataset.scope !== "exclude");
  });
}
addEventListener("DOMContentLoaded", loadState);
"""


def _shot(slug: str, i: int, img: dict) -> str:
    sid = f"{slug}#{i}"
    obs = img.get("observation_url") or img.get("photo_url") or img["url"]
    return f"""      <div class="shot" data-id="{html.escape(sid)}">
        <a href="{html.escape(img["url"])}" target="_blank" rel="noopener">
          <img loading="lazy" src="{html.escape(_medium_url(img["url"]))}" alt=""></a>
        <div class="cap">{html.escape(img.get("credit") or "ukendt")}
          · {html.escape(img.get("license") or "")}
          · <a href="{html.escape(obs)}" target="_blank" rel="noopener">fund</a></div>
        <div class="btns">
          <button class="k" onclick="setShot('{html.escape(sid)}','keep')">Keep</button>
          <button class="r" onclick="setShot('{html.escape(sid)}','reject')">Reject</button>
        </div>
      </div>"""


def _card(sp: dict, description: str, excluded: bool) -> str:
    slug = slugify(sp["scientific_name"])
    baseline = "exclude" if excluded else "include"
    imgs = []
    path = IMAGES_DIR / f"{slug}.json"
    if path.exists():
        imgs = json.loads(path.read_text(encoding="utf-8"))
    shots = "\n".join(_shot(slug, i, im) for i, im in enumerate(imgs))
    if not imgs:
        shots = '      <p class="empty">No photo — hand-pick one.</p>'
    esc_desc = html.escape(description)
    return f"""  <section class="sp" data-slug="{slug}" data-baseline="{baseline}"
      data-scope="{baseline}">
    <div class="head">
      <h2>{html.escape(sp["danish_name"])}
        <span class="sci">{html.escape(sp["scientific_name"])}</span></h2>
      <label class="scope">
        <input type="checkbox" disabled {"" if excluded else "checked"}
          onchange="setScope('{slug}', '{baseline}', this.checked)">
        <span class="label">{"Excluded from" if excluded else "Included in"} the app</span>
        <span class="changed" hidden>· changed</span></label>
    </div>
    <p class="meta">{sp["tier"]} · {sp["group"]} · {len(imgs)} photo(s) · {slug}</p>
    <div class="shots">
{shots}
    </div>
    <label class="none">
      <input type="checkbox" onchange="setNone('{slug}', this.checked)">
      None of these show the species</label>
    <div class="desc">
      <label for="d-{slug}">Description (Danish, edit directly)</label>
      <textarea id="d-{slug}" data-slug="{slug}" data-original="{esc_desc}" disabled
        oninput="setDescription('{slug}', this.dataset.original, this.value)"
        onblur="setDescription('{slug}', this.dataset.original, this.value)">{esc_desc}</textarea>
      <p class="edited" hidden>Edited from the original — saved automatically.</p>
    </div>
  </section>"""


def main() -> None:
    species = sorted(candidate_species(), key=lambda s: (s["group"], s["danish_name"]))
    excluded = excluded_slugs()
    descriptions = {}
    for sp in species:
        slug = slugify(sp["scientific_name"])
        path = DESCRIPTIONS_DIR / f"{slug}.md"
        descriptions[slug] = path.read_text(encoding="utf-8").strip() if path.exists() else ""

    cards = "\n".join(
        _card(
            s,
            descriptions[slugify(s["scientific_name"])],
            slugify(s["scientific_name"]) in excluded,
        )
        for s in species
    )
    script = SCRIPT.replace("%TOKEN%", API_TOKEN)

    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Species Review</title>
<style>{STYLE}</style>
</head>
<body>
<header>
  <h1>Photo &amp; description review</h1>
  <span id="count" class="count">…</span>
  <span id="syncstate" class="syncstate" data-state="loading">Loading…</span>
  <select onchange="filter(this.value)">
    <option value="all">show all</option>
    <option value="undecided">hide finished</option>
    <option value="attention">only flagged / rejected</option>
    <option value="included">only species in the app</option>
    <option value="excluded">only excluded species</option>
  </select>
</header>
<p class="howto">Your keep/reject choices, edited descriptions and the "Included in the app"
  switches save automatically as you go — shared and live, so it's safe to close the tab and come
  back later, on any device. Switching a species off removes it from the app the next time the
  choices are applied; nothing is deleted, and it can be switched back on here.</p>
<main>
{cards}
</main>
<script>{script}</script>
</body>
</html>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(doc, encoding="utf-8")
    n_photos = sum(
        len(json.loads((IMAGES_DIR / f"{slugify(s['scientific_name'])}.json").read_text("utf-8")))
        for s in species
        if (IMAGES_DIR / f"{slugify(s['scientific_name'])}.json").exists()
    )
    print(f"{OUT}  —  {len(species)} species ({len(excluded)} excluded), {n_photos} photos")


if __name__ == "__main__":
    main()
