const ic = (n, c = 'ico') => `<svg class="${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

const API = 'https://paleobiodb.org/data1.2';
const RADIUS = 100, WIDE = 250;   // miles: the regional search, and the wider look when nothing turns up nearby
// The non-dinosaur animals we count around each place, as PBDB taxon names.
const XQUERY = {trilobite:'Trilobita', ammonite:'Ammonoidea', dunkleosteus:'Dunkleosteus', eurypterus:'Eurypterus', mosasaur:'Tylosaurus,Mosasaurus',
  elasmosaurus:'Elasmosaurus', xiphactinus:'Xiphactinus', cretoxyrhina:'Cretoxyrhina', pteranodon:'Pteranodon', archelon:'Archelon', otodus:'Otodus',
  mammuthus:'Mammuthus', mammut:'Mammut', smilodon:'Smilodon', sloth:'Megalonyx,Eremotherium'};

let currentX = null, SNAP = null, GEN = null, DATA = null, place = null, view = 'home', rng = [0, 2], sortBy = 'featured', current = null, loading = null;
const app = document.getElementById('app');
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function stateFromZip(z){
  const p = +z.slice(0,3), hit = ZIP3.find(([a,b]) => p >= a && p <= b);
  return hit ? hit[2] : null;
}

// ZIP code -> place. Sample ZIPs are built in; others come from Zippopotam, or fall back to the state when offline.
async function placeFromZip(z){
  if (PLACES[z]) return {zip:z, ...PLACES[z]};
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${z}`);
    if (r.status === 404) return {zip:z, none:true};
    const j = await r.json(), p = j.places[0];
    return {zip:z, town:p['place name'], st:p['state abbreviation'], state:p.state, lat:+p.latitude, lng:+p.longitude};
  } catch {
    const state = stateFromZip(z);
    return state ? {zip:z, town:'', st:ABBR[state] || '', state, offline:true} : {zip:z, none:true};
  }
}

// Place names come from outside services and go into the page, so keep them to plain text.
const clean = s => String(s || '').replace(/[<>&"]/g, '');
const coordLabel = (lat, lng) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'W'}`;

// A Nominatim address -> place. US places keep the state abbreviation; elsewhere the country stands in for it.
function placeFromAddress(lat, lng, a, name){
  lat = +(+lat).toFixed(2); lng = +(+lng).toFixed(2);
  const cc = a.country_code || '';
  const town = clean(name || a.city || a.town || a.village || a.hamlet || (cc === 'us' ? a.county : '') || '');
  if (cc === 'us') {
    const st = (a['ISO3166-2-lvl4'] || '').replace('US-', '');
    return {lat, lng, cc, town, st, state:clean(a.state) || Object.keys(ABBR).find(k => ABBR[k] === st) || ''};
  }
  const country = clean(a.country);
  if (!cc) return {lat, lng, cc, town:coordLabel(lat, lng), st:'', state:'', sea:true};
  // out in the countryside, the province or region reads better than a district name
  return {lat, lng, cc, town:town || clean(a.state || a.region || a.county) || country, st:country, state:clean(a.state || a.region), country};
}

// Coordinates -> place, rounded to about a kilometer so we never keep an exact position.
async function placeFromCoords(lat, lng){
  lat = +lat.toFixed(2); lng = +lng.toFixed(2);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lng}`, {headers:{'Accept-Language':'en'}});
    return placeFromAddress(lat, lng, (await r.json()).address || {});
  } catch {
    return {lat, lng, town:coordLabel(lat, lng), st:'', state:''};
  }
}

// A typed place name -> up to five matching places, anywhere in the world.
async function placesFromSearch(q){
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`, {headers:{'Accept-Language':'en'}});
  const seen = new Set();
  return (await r.json()).map(x => placeFromAddress(x.lat, x.lon, x.address || {}, x.name))
    .filter(p => { const k = placeName(p); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Miles in the US, kilometers everywhere else.
const isUS = pl => !!pl.zip || pl.cc === 'us' || (!pl.cc && !pl.sea);
const dist = (pl, mi) => isUS(pl) ? `${mi} miles` : `${Math.round(mi * 1.609 / 10) * 10} km`;

const box = (lat, lng, mi) => {
  const dLat = mi / 69, dLng = mi / (69 * Math.cos(lat * Math.PI / 180));
  return `lngmin=${(lng-dLng).toFixed(3)}&lngmax=${(lng+dLng).toFixed(3)}&latmin=${(lat-dLat).toFixed(3)}&latmax=${(lat+dLat).toFixed(3)}`;
};
async function getJSON(url, signal){ const r = await fetch(url, {signal}); if (!r.ok) throw new Error(r.status); return r.json(); }
const loadGen = () => GEN ? Promise.resolve(GEN) : fetch('data/genera.json').then(r => r.json()).then(j => GEN = j);
const loadSnap = () => SNAP ? Promise.resolve(SNAP) : fetch('data/snapshot.json').then(r => r.json()).then(j => SNAP = j);

// Group occurrence records by genus: [genus, records, top formations, oldest Ma, youngest Ma].
function aggregate(recs){
  const d = {}, t = {};
  for (const x of recs) {
    const g = x.gnl;
    if (!g || +x.eag <= 66) continue;               // non-bird dinosaurs only lived before 66 million years ago
    const b = (GEN[g]?.[4] ? t : d)[g] ||= {n:0, f:{}, ea:0, la:999};
    b.n++; b.ea = Math.max(b.ea, +x.eag); b.la = Math.min(b.la, +x.lag);
    if (x.sfm) { const f = x.sfm.replace(/ Fm\.?$/, ''); b.f[f] = (b.f[f] || 0) + 1; }
  }
  const rows = D => Object.entries(D).map(([g,v]) => [g, v.n, Object.entries(v.f).sort((a,b) => b[1]-a[1]).slice(0,2).map(e => e[0]), +v.ea.toFixed(1), +v.la.toFixed(1)]).sort((a,b) => b[1]-a[1]);
  return {d:rows(d), t:rows(t)};
}

async function lookupLive(pl, signal){
  await loadGen();
  const dinos = mi => getJSON(`${API}/occs/list.json?base_name=Dinosauria^Aves&${box(pl.lat, pl.lng, mi)}&show=class,strat&limit=all`, signal).then(j => aggregate(j.records || []));
  const count = q => getJSON(`${API}/occs/list.json?base_name=${q}&${box(pl.lat, pl.lng, RADIUS)}&limit=0&rowcount`, signal).then(j => j.records_found || 0);
  const [near, counts] = await Promise.all([dinos(RADIUS), Promise.all(Object.values(XQUERY).map(count))]);
  let rec = near, mi = RADIUS;
  if (!near.d.length) { const wide = await dinos(WIDE); if (wide.d.length) { rec = {d:wide.d, t:near.t}; mi = WIDE; } }
  const x = Object.fromEntries(Object.keys(XQUERY).map((k,i) => [k, counts[i]]).filter(([,n]) => n));
  return {...rec, x, mi, source:'live', at:Date.now()};
}

async function lookupSnapshot(pl){
  await Promise.all([loadSnap(), loadGen()]);
  // statewide records only exist for the US; elsewhere there's nothing honest to show offline
  if (!isUS(pl) || !SNAP.STATES[pl.key || pl.state]) throw new Error('offline');
  const s = SNAP.STATES[pl.key || pl.state];
  return {d:s.d, t:s.t, x:SNAP.STATES[pl.state]?.x || {}, mi:0, source:'snapshot'};
}

// Live first; if that fails, the last result saved on this device; then the saved October 2026 copy.
async function lookup(pl, signal){
  const key = 'dt:' + (pl.lat != null ? `${pl.lat.toFixed(2)},${pl.lng.toFixed(2)}` : pl.state);
  if (pl.lat != null && navigator.onLine !== false) {
    try { const r = await lookupLive(pl, signal); store.set(key, r); return r; }
    catch (e) { if (e.name === 'AbortError') throw e; }
  }
  const saved = store.get(key);
  if (saved) { await loadGen(); return {...saved, source:'saved'}; }
  return lookupSnapshot(pl);
}

const periodOf = ma => PERIODS.find(p => ma <= p.from && ma > p.to) || PERIODS[2];
function subAge(ma){ const p = periodOf(ma); return p.parts.find(([lim]) => ma > lim)[1] + ' ' + p.name; }
const fmtMa = (a,b) => Math.round(a) === Math.round(b) ? `About ${Math.round(a)} million years ago` : `${Math.round(a)}–${Math.round(b)} million years ago`;

// Turn a lookup into what the screens show, with wording for how far the search reached.
function shape(pl, L){
  const isEgg = g => /oolith|ovum$/i.test(g);
  const name = pl.town || (pl.zip ? `ZIP ${pl.zip}` : 'here');
  const near = L.source === 'snapshot' ? `in ${pl.state}` : `within ${dist(pl, RADIUS)} of ${name}`;
  const dnear = L.source === 'snapshot' ? near : `within ${dist(pl, L.mi)} of ${name}`;
  const d = L.d.filter(r => !isEgg(r[0])).map(([g,n,f,ea,la]) => {
    const [grp, fam, att, ttl] = GEN[g] || ['other','','',''];
    const mid = (ea+la)/2, per = periodOf(mid);
    const diet = grp === 'theropod' && OMNI.includes(fam) ? 'Omnivore' : GROUPS[grp][1];
    return {g, n, f, ea, la, grp, fam, att, sci: GUIDE[g]?.sci || ttl || '', per: per.id, sub: subAge(mid), diet};
  });
  return {d, t:L.t, e:L.d.filter(r => isEgg(r[0])), x:L.x, near, dnear, wide:L.mi === WIDE, source:L.source, at:L.at,
    region: L.source === 'snapshot' ? `Across ${pl.state} · saved records` : isUS(pl) ? `${L.mi}-mile radius` : `${dist(pl, L.mi)} radius`};
}
const dinosFor = () => DATA;

function silFor(x){
  if (SIL[x.g]) return SIL[x.g];
  const f = FAMSIL[x.fam] || GRPSIL[x.grp] || GRPSIL.other;
  return f && [f[0], f[1], f[2], f[3]];
}

function sorted(list){
  const by = {
    featured:(a,b) => (!!ART[b.g] - !!ART[a.g]) || (!!GUIDE[b.g] - !!GUIDE[a.g]) || ((a.grp === 'bird') - (b.grp === 'bird')) || b.n - a.n,
    records:(a,b) => b.n - a.n, oldest:(a,b) => b.ea - a.ea, newest:(a,b) => a.la - b.la, az:(a,b) => a.g.localeCompare(b.g),
  }[sortBy];
  return [...list].sort(by);
}

function artBox(x, label = true){
  const fm = label && x.f[0] ? `<span class="fm">${x.f[0]} Formation</span>` : '';
  if (ART[x.g]) return `<div class="art">${fm}<img src="art/${ART[x.g]}.jpg" alt="${x.g} illustration" loading="lazy"></div>`;
  const s = silFor(x);
  if (s) return `<div class="art sil ${x.per}">${fm}<span class="shape" style="--m:url('art/sil/${s[0]}.png')" role="img" aria-label="${s[3] ? 'Silhouette of a related ' + s[3] : x.g + ' silhouette'}"></span><span class="note">${s[3] ? 'Related ' + s[3] : 'Silhouette'}</span></div>`;
  return `<div class="art pending">${fm}<span class="ghost">${x.g}</span><span class="note">Illustration coming</span></div>`;
}

function card(x, mini = false){
  return `<button class="card ${x.per}" data-dino="${x.g}">
    ${artBox(x, !mini)}
    <div class="card-body">
      <div class="card-title"><h3>${x.g}</h3>${ic('out')}</div>
      ${mini ? '' : `<p class="sci">${x.sci || x.fam || '&nbsp;'}</p>`}
      <div class="row"><span class="tag ${x.per}">${x.sub}</span>${mini ? '' : `<span>${GROUPS[x.grp][0]} · ${x.diet}</span>`}</div>
      ${mini ? '' : `<div class="age">${fmtMa(x.ea, x.la)}</div>`}
    </div></button>`;
}

const placeName = pl => pl.town && pl.st ? `${pl.town}, ${pl.st}` : pl.town ? pl.town : pl.zip ? `${pl.zip} · ${pl.st}` : pl.st || 'Your area';
// The longer form for the breadcrumb: ZIP, town, state or region, and the country outside the US.
const placeLine = pl => [pl.zip, [pl.town, pl.state, pl.country].filter((s, i, a) => s && a.indexOf(s) === i).join(', ')].filter(Boolean).join(' · ') || 'Your location';

function setNav(){
  document.getElementById('nav-explore').setAttribute('aria-current', view !== 'about' ? 'page' : 'false');
  document.getElementById('nav-about').setAttribute('aria-current', view === 'about' ? 'page' : 'false');
  const pill = document.getElementById('loc-pill');
  pill.hidden = !place || view === 'home' || view === 'about';
  if (place) pill.querySelector('span').textContent = placeName(place);
  pill.setAttribute('aria-label', 'Change location');
}

// Every screen has its own address, so links can be shared and the back button works.
function urlFor(v){
  const q = new URLSearchParams();
  if (v === 'about') q.set('about', '');
  else if (v === 'home' && mapDino) q.set('find', mapDino);
  else if (place && v !== 'home') {
    if (place.zip) q.set('zip', place.zip); else q.set('at', `${place.lat},${place.lng}`);
    if (v === 'detail') q.set('dino', current);
    if (v === 'xdetail') q.set('x', currentX);
  }
  const s = q.toString().replace(/=(&|$)/, '$1').replace(/%2C/g, ',');
  return location.pathname + (s ? '?' + s : '');
}

function go(v, opts = {}){
  view = v; if (opts.dino) current = opts.dino; if (opts.x) currentX = opts.x;
  if (opts.history !== false) {
    const u = urlFor(v);
    if (u !== location.pathname + location.search) history[opts.replace ? 'replaceState' : 'pushState']({}, '', u);
  }
  document.title = v === 'detail' ? `${current} · Dino Tracker` : v === 'results' && place ? `${placeName(place)} · Dino Tracker` : 'Dino Tracker';
  setNav();
  ({home:renderHome, results:renderResults, detail:renderDetail, xdetail:renderX, about:renderAbout})[v]();
  if (!opts.keepScroll) window.scrollTo(0, 0);
}

/* ---------- home ---------- */
function renderHome(){
  const z = place?.zip || '';
  app.innerHTML = `<div class="home">
  <div class="intro-row"><div class="intro"><span class="eyebrow">Explore your prehistoric neighborhood</span><h1>Who walked here before you?</h1>
    <p>Find the dinosaurs that once called your corner of the world home. Start with where you are.</p></div>
    <span class="meta-r">Field notes / Planet Earth</span></div>
  <div class="home-grid">
    <section class="findcard" aria-labelledby="find-h">
      <div class="fhead"><h2 id="find-h">${ic('pin')}Find your location</h2><p>Use your current location, or enter a US ZIP code or any place in the world.</p></div>
      <div class="opt"><button class="btn primary" id="gps">${ic('gps')}Use my location</button>
        <div class="hint">Uses GPS · Your browser will ask for permission</div><div id="gps-note" hidden></div></div>
      <div class="or">or search for a place</div>
      <div class="zipopt"><label class="f" for="zip">ZIP code or place name</label>
        <div class="zipbox"><input class="zip" id="zip" autocomplete="off" enterkeyhint="search" placeholder="e.g. 80401 or Patagonia" value="${z}">${ic('pin')}</div>
        <div class="resolved" id="zip-out" aria-live="polite"></div>
        <button class="btn" id="find" disabled>${ic('arrow')}Find dinosaurs</button></div>
    </section>
    <figure class="scene">
      <img src="art/hero.jpg" alt="Illustrated Late Jurassic river valley with a long-necked sauropod browsing a conifer and two more in the distance">
      <span class="stamp">${ic('clock')}COLORADO / 150 MILLION YEARS AGO</span>
      <figcaption class="cap"><h3>A very different kind of local.</h3><p>An imagined scene from the Late Jurassic Front Range.</p></figcaption>
    </figure>
  </div>
  <div class="samples"><span class="eyebrow">Or try a sample place</span>
    <div class="chips">${SAMPLE_ZIPS.map(k => `<button class="chip" data-zip="${k}">${PLACES[k].town}, ${PLACES[k].st}</button>`).join('')}
      ${WORLD.map(([n, lat, lng]) => `<button class="chip" data-at="${lat},${lng}" data-name="${n}">${n}</button>`).join('')}</div></div>
  <section class="mapcard" aria-labelledby="map-h">
    <div class="mhead"><div><span class="eyebrow">Explore the map</span><h2 id="map-h">Pick any spot on Earth</h2></div>
      <p>Each dot marks dinosaur fossils found there. Bigger dots, more finds. Tap anywhere to see who lived nearby, or look up a dinosaur to see everywhere it’s been found.</p></div>
    <div class="dsearch"><label class="f" for="dq">Look up a dinosaur</label>
      <div class="zipbox"><input class="zip" id="dq" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="dq-list" autocomplete="off" spellcheck="false" enterkeyhint="search" placeholder="e.g. Tyrannosaurus" value="${mapDino || ''}">${ic('search')}
        <ul class="dq-list" id="dq-list" role="listbox" aria-label="Dinosaurs" hidden></ul></div>
      <div class="resolved" id="dq-out" aria-live="polite"></div></div>
    <div class="dfound" id="dfound" aria-live="polite" hidden></div>
    <div class="map" id="map" aria-label="World map of dinosaur fossil finds"><div class="map-msg">Loading the map…</div></div>
  </section>
  <div class="guide">
    <div class="ctx"><span class="eyebrow">A place, not a pinpoint</span><p>Your starting point sets a region. Results describe fossil records across the surrounding area, not a fossil site at your address.</p></div>
    <div class="steps">
      <div class="step">${ic('map')}<h4>Start somewhere</h4><p>Choose any place on Earth.</p></div>
      <div class="step">${ic('sliders')}<h4>Travel through time</h4><p>Narrow your discoveries by geologic period.</p></div>
      <div class="step">${ic('note')}<h4>Meet the locals</h4><p>Open a field guide to each dinosaur.</p></div>
    </div>
  </div></div>`;
  const zip = document.getElementById('zip'), out = document.getElementById('zip-out'), find = document.getElementById('find');
  let found = null, seq = 0;
  const isZip = v => /^\d{5}$/.test(v);
  // Five digits look up a US ZIP as you type. Anything else waits for Enter, since the place search is a shared free service.
  const check = async () => {
    const v = zip.value.trim();
    found = null; out.className = 'resolved'; out.textContent = '';
    find.disabled = v.length < 2 || (/^\d+$/.test(v) && !isZip(v));
    if (!isZip(v)) return;
    find.disabled = true;
    const my = ++seq; out.textContent = 'Looking up ZIP code…';
    const r = await placeFromZip(v);
    if (my !== seq) return;
    if (r.none) { out.textContent = 'We couldn’t find that ZIP code. Check the digits and try again.'; out.classList.add('err'); return; }
    found = r; find.disabled = false;
    out.textContent = r.offline ? `${r.state} · you’re offline, so results cover the whole state` : `${r.town}, ${r.state}`;
  };
  const search = async () => {
    const v = zip.value.trim();
    if (found) return open(found);
    if (isZip(v) || v.length < 2) return;
    const my = ++seq; out.className = 'resolved'; out.textContent = 'Searching for places…'; find.disabled = true;
    let list;
    try { list = await placesFromSearch(v); } catch { list = null; }
    if (my !== seq) return;
    find.disabled = false;
    if (!list) { out.textContent = 'We couldn’t search for places right now. Check your connection and try again.'; out.classList.add('err'); return; }
    if (!list.length) { out.textContent = `We couldn’t find “${clean(v)}”. Try a town, region or country.`; out.classList.add('err'); return; }
    if (list.length === 1) return open(list[0]);
    out.innerHTML = `<span>Which one?</span><div class="chips picks">${list.map((p, i) => `<button class="chip" data-pick="${i}">${placeLine(p)}</button>`).join('')}</div>`;
    out.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => open(list[+b.dataset.pick])));
  };
  zip.addEventListener('input', check);
  zip.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  find.addEventListener('click', search);
  document.getElementById('gps').addEventListener('click', () => {
    const n = document.getElementById('gps-note');
    n.hidden = false; n.className = 'notice';
    // Explain before the browser asks, so the permission prompt is never a surprise.
    n.innerHTML = `<div><b>Find fossils near you</b><br>Dino Tracker uses your location once to search the surrounding region. It’s rounded to about a kilometer and never stored or shared.</div>
      <div class="chips"><button class="chip" id="gps-go">Continue</button><button class="chip" id="gps-no">Search for a place instead</button></div>`;
    document.getElementById('gps-no').onclick = () => { n.hidden = true; zip.focus(); };
    document.getElementById('gps-go').onclick = () => {
      if (!navigator.geolocation) { n.innerHTML = '<div>This browser can’t share its location. Search for a place instead.</div>'; return; }
      n.innerHTML = '<div>Finding your location…</div>';
      navigator.geolocation.getCurrentPosition(async pos => open(await placeFromCoords(pos.coords.latitude, pos.coords.longitude)), err => {
        n.innerHTML = err.code === 1
          ? '<div><b>Location is turned off for this site.</b> You can allow it in your browser settings, or search for a place instead.</div>'
          : '<div><b>We couldn’t get your location.</b> Check your signal and try again, or search for a place.</div>';
      }, {enableHighAccuracy:false, timeout:15000, maximumAge:600000});
    };
  });
  if (zip.value) check();
  dinoSearch();
  // The map library only loads once the map scrolls near the screen.
  const el = document.getElementById('map');
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); initMap(el); } }, {rootMargin:'300px'});
  io.observe(el);
  if (mapDino) showDino(mapDino);
}

/* ---------- dinosaur search ---------- */
// Every named dinosaur in the database, minus footprints and eggshell, which are named apart from the animals.
let NAMES = null;
const loadNames = () => loadGen().then(G => NAMES ||= Object.keys(G).filter(g => !G[g][4] && !/oolith|ovum$/i.test(g)).sort());
function matchNames(q){
  // Painted and well-known dinosaurs first, then the ones with the most fossil records.
  const s = q.toLowerCase(), rank = g => (ART[g] ? -1e5 : GUIDE[g] ? -5e4 : 0) - (GEN[g][5] || 0);
  const pre = NAMES.filter(g => g.toLowerCase().startsWith(s)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const mid = s.length > 2 ? NAMES.filter(g => !g.toLowerCase().startsWith(s) && g.toLowerCase().includes(s)) : [];
  const hits = [...pre, ...mid];
  if (hits.length || s.length < 4) return hits.slice(0, 8);
  // Nothing matches as typed, so offer close spellings: Tyranosaurus finds Tyrannosaurus.
  const tol = s.length > 6 ? 2 : 1;
  return NAMES.map(g => [g, Math.min(edits(s, g.toLowerCase().slice(0, s.length)), edits(s, g.toLowerCase()))]).filter(([, d]) => d <= tol)
    .sort((a, b) => a[1] - b[1] || rank(a[0]) - rank(b[0])).slice(0, 5).map(([g]) => g);
}
function edits(a, b){
  let prev = Array.from({length:b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
}
function dinoSearch(){
  const q = document.getElementById('dq'), list = document.getElementById('dq-list'), out = document.getElementById('dq-out');
  let opts = [], at = -1;
  const close = () => { list.hidden = true; q.setAttribute('aria-expanded', 'false'); q.removeAttribute('aria-activedescendant'); at = -1; };
  const mark = i => {
    at = i;
    list.querySelectorAll('li').forEach((li, j) => li.setAttribute('aria-selected', j === i));
    if (i >= 0) q.setAttribute('aria-activedescendant', 'dq-o' + i); else q.removeAttribute('aria-activedescendant');
  };
  const pick = g => { q.value = g; close(); out.textContent = ''; showDino(g); history.replaceState({}, '', urlFor('home')); };
  q.addEventListener('focus', loadNames, {once:true});
  q.addEventListener('input', async () => {
    out.className = 'resolved'; out.textContent = '';
    const v = q.value.trim();
    if (v.length < 2) return close();
    await loadNames();
    if (q.value.trim() !== v) return;
    opts = matchNames(v);
    if (!opts.length) return close();
    list.innerHTML = opts.map((g, j) => {
      const k = Math.max(0, g.toLowerCase().indexOf(v.toLowerCase())), i = g.toLowerCase().includes(v.toLowerCase()) ? v.length : 0;
      return `<li role="option" id="dq-o${j}" data-g="${g}" aria-selected="false"><span class="nm">${g.slice(0, k)}<b>${g.slice(k, k + i)}</b>${g.slice(k + i)}</span><span>${GROUPS[GEN[g][0]]?.[0] || 'Dinosaur'}</span></li>`;
    }).join('');
    list.hidden = false; q.setAttribute('aria-expanded', 'true'); mark(-1);
  });
  q.addEventListener('keydown', async e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) return;
      e.preventDefault();
      mark(e.key === 'ArrowDown' ? (at + 1) % opts.length : at <= 0 ? opts.length - 1 : at - 1);
    } else if (e.key === 'Escape') close();
    else if (e.key === 'Enter') {
      const v = q.value.trim();
      if (!list.hidden && at >= 0) return pick(opts[at]);
      if (v.length < 2) return;
      await loadNames();
      const hit = NAMES.find(g => g.toLowerCase() === v.toLowerCase()) || (!list.hidden && opts[0]);
      if (hit) return pick(hit);
      out.textContent = `We couldn’t find a dinosaur named “${clean(v)}”. Check the spelling, or try its genus, like Triceratops.`; out.classList.add('err');
    }
  });
  // mousedown, not click, so the pick lands before the input loses focus and the list closes
  list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(li.dataset.g); } });
  q.addEventListener('blur', () => setTimeout(close, 100));
}

const REGION = (() => { try { return new Intl.DisplayNames(['en'], {type:'region'}); } catch { return null; } })();
const countryOf = cc => { cc = cc === 'UK' ? 'GB' : cc; try { return REGION?.of(cc) || cc; } catch { return cc; } };

// Look up every fossil record of one dinosaur and group them into sites for the map.
let mapDino = null, FOUND = null, dseq = 0;
async function showDino(g){
  const box = document.getElementById('dfound'), my = ++dseq;
  mapDino = g; FOUND = null; plotDino();
  if (!box) return;
  if (!g) { box.hidden = true; return; }
  box.hidden = false; box.className = 'dfound'; box.innerHTML = `<span class="dmsg">Finding every ${g} fossil…</span>`;
  let recs;
  try { [recs] = await Promise.all([getJSON(`${API}/occs/list.json?base_name=${encodeURIComponent(g)}&show=coords,loc&vocab=pbdb&limit=all`).then(j => j.records || []), loadGen()]); }
  catch { recs = null; }
  if (my !== dseq || !box.isConnected) return;
  const reset = '<button class="chip" id="dclear">Show all dinosaurs</button>';
  if (!recs) { box.innerHTML = `<span class="dmsg">We couldn’t reach the fossil database. Check your connection and try again.</span>${reset}`; return wireClear(); }
  const sites = {};
  for (const r of recs) {
    if (r.lat == null || r.lng == null) continue;
    const key = `${(+r.lat).toFixed(1)},${(+r.lng).toFixed(1)}`;
    const s = sites[key] ||= {lat:+r.lat, lng:+r.lng, n:0, cc:r.cc, state:r.state, county:r.county, ea:0, la:999};
    s.n++; s.ea = Math.max(s.ea, +r.max_ma); s.la = Math.min(s.la, +r.min_ma);
  }
  const S = Object.values(sites);
  if (!S.length) { box.innerHTML = `<span class="dmsg">No mapped fossil records of ${g} yet.</span>${reset}`; return wireClear(); }
  const cs = {};
  for (const s of S) if (s.cc) cs[s.cc] = (cs[s.cc] || 0) + s.n;
  const top = Object.entries(cs).sort((a, b) => b[1] - a[1]).map(([c]) => countryOf(c));
  const ea = Math.max(...S.map(s => s.ea)), la = Math.min(...S.map(s => s.la)), n = S.reduce((a, s) => a + s.n, 0);
  const [grp, fam] = GEN[g] || ['other', ''], x = {g, grp, fam, per:periodOf(Math.max(la, 66.1)).id};
  const sil = !ART[g] && silFor(x);
  const thumb = ART[g] ? `<img src="art/${ART[g]}.jpg" alt="">` : sil ? `<span class="shape" style="--m:url('art/sil/${sil[0]}.png')"></span>` : '';
  box.className = `dfound ${x.per}`;
  box.innerHTML = `<div class="dthumb">${thumb}</div>
    <div class="dtext"><h3>${g}</h3>
      <p>${GROUPS[grp]?.[0] || 'Dinosaur'}${fam ? ' · ' + fam : ''} · ${fmtMa(ea, la)}</p>
      <p>${n} fossil record${n > 1 ? 's' : ''} at ${S.length} site${S.length > 1 ? 's' : ''} · ${top.slice(0, 3).join(', ')}${top.length > 3 ? ` and ${top.length - 3} more ${top.length - 3 > 1 ? 'countries' : 'country'}` : ''}</p></div>
    ${reset}`;
  FOUND = {g, S};
  wireClear(); plotDino();
}
function wireClear(){
  document.getElementById('dclear')?.addEventListener('click', () => {
    const q = document.getElementById('dq'); if (q) q.value = '';
    showDino(null); history.replaceState({}, '', urlFor('home'));
  });
}

/* ---------- world map ---------- */
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
let leafletReady = null, HOT = null, MAP = null, HOTS = null, SITES = null;
function loadLeaflet(){
  return leafletReady ||= new Promise((res, rej) => {
    const css = Object.assign(document.createElement('link'), {rel:'stylesheet', href:LEAFLET + 'leaflet.min.css'});
    const js = Object.assign(document.createElement('script'), {src:LEAFLET + 'leaflet.min.js', onload:res, onerror:() => { leafletReady = null; rej(); }});
    document.head.append(css, js);
  });
}
async function initMap(el){
  try { await loadLeaflet(); HOT ||= await fetch('data/hotspots.json').then(r => r.json()); }
  catch { el.innerHTML = '<div class="map-msg">The map needs an internet connection. You can still search for a place above.</div>'; return; }
  if (!el.isConnected) return;
  el.innerHTML = '';
  const map = MAP = L.map(el, {worldCopyJump:true, minZoom:el.clientWidth < 500 ? .5 : 1.5, maxZoom:10, scrollWheelZoom:false, preferCanvas:true, zoomSnap:.5});
  if (place?.lat != null) map.setView([place.lat, place.lng], 5); else map.fitBounds([[-55, -130], [72, 150]]);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, className:'dt-tiles',
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  const k = el.clientWidth < 500 ? .6 : 1;   // smaller dots on a phone-sized map
  HOTS = L.layerGroup(HOT.map(([la, ln, n]) => L.circleMarker([la, ln], {radius:k * Math.min(14, 2.5 + Math.sqrt(n) * .55), stroke:false, fillColor:'#5b6bff', fillOpacity:.42, interactive:false}))).addTo(map);
  SITES = null; plotDino();
  let pin = null, seq = 0;
  map.on('click', async e => {
    const {lat, lng} = e.latlng.wrap(), my = ++seq;
    pin?.remove();
    pin = L.circleMarker(e.latlng, {radius:8, color:'#fff', weight:3, fillColor:'#2f3a8f', fillOpacity:1}).addTo(map);
    const pop = L.popup({closeButton:false, className:'dt-pop', offset:[0, -6]}).setLatLng(e.latlng).setContent('<div class="pop">Looking up this spot…</div>').openOn(map);
    const pl = await placeFromCoords(lat, lng);
    if (my !== seq) return;
    pop.setContent(`<div class="pop"><b>${pl.sea ? 'Open ocean' : placeName(pl)}</b><span>${pl.sea ? pl.town : coordLabel(pl.lat, pl.lng)}</span><button class="btn primary" type="button">${ic('arrow')}Find dinosaurs here</button></div>`);
    pop.getElement()?.querySelector('button')?.addEventListener('click', () => open(pl));
  });
}

// Mark every site where the looked-up dinosaur has been found, and fade the other dots behind them.
function plotDino(){
  if (!MAP || !MAP.getContainer().isConnected) return;
  SITES?.remove(); SITES = null;
  HOTS?.eachLayer(c => c.setStyle({fillOpacity:FOUND ? .14 : .42}));
  if (!FOUND) return;
  const {g, S} = FOUND, small = MAP.getContainer().clientWidth < 500;
  SITES = L.layerGroup(S.map(s => L.circleMarker([s.lat, s.lng], {radius:(small ? .8 : 1) * Math.min(12, 5 + Math.sqrt(s.n) * 1.2), color:'#fff', weight:2, fillColor:'#2f3a8f', fillOpacity:.92, bubblingMouseEvents:false})
    .bindPopup(() => {
      const where = [s.county, s.state, countryOf(s.cc)].filter((v, i, a) => v && a.indexOf(v) === i).join(', ') || coordLabel(s.lat, s.lng);
      const at = `${s.lat.toFixed(2)},${s.lng.toFixed(2)}`;
      return `<div class="pop"><b>${clean(where)}</b><span>${s.n} ${g} record${s.n > 1 ? 's' : ''} · ${fmtMa(s.ea, s.la).replace(' million years ago', ' Ma')}</span>
        <a class="btn primary" href="?at=${at}&dino=${g}" data-nav>${ic('arrow')}Meet ${g} here</a>
        <a class="btn" href="?at=${at}" data-nav>See who lived nearby</a></div>`;
    }, {closeButton:false, className:'dt-pop', offset:[0, -4]}))).addTo(MAP);
  const b = L.latLngBounds(S.map(s => [s.lat, s.lng]));
  if (S.length === 1) MAP.setView(b.getCenter(), 5);
  else MAP.fitBounds(b, {padding:[36, 36], maxZoom:6});
}

// Open a place: show the results screen right away in a loading state, then fill it in.
async function open(pl, opts = {}){
  loading?.abort();
  const ctl = loading = new AbortController();
  place = pl; DATA = null; rng = [0, 2]; sortBy = 'featured';
  if (!opts.then) go('results', opts);
  try {
    const L = await lookup(pl, ctl.signal);
    if (ctl.signal.aborted) return;
    DATA = shape(pl, L);
  } catch (e) {
    if (e.name === 'AbortError') return;
    DATA = {error:true};
  }
  if (loading === ctl) loading = null;
  if (opts.then) go(opts.then, {history:false});
  else if (view === 'results') go('results', {history:false, keepScroll:true});
}
const inRange = id => { const i = PERIODS.findIndex(p => p.id === id); return i >= rng[0] && i <= rng[1]; };

/* ---------- results ---------- */
function headlineFor(pl, data){
  const xs = Object.keys(data.x);
  const ice = xs.filter(k => INSTEAD[k]?.era === 'ice').length, oldSea = (data.x.trilobite || 0) + (data.x.dunkleosteus || 0) + (data.x.eurypterus || 0);
  const crSea = xs.some(k => /^Cretaceous/.test(INSTEAD[k]?.tag || ''));
  if (pl.headline) return pl.headline;
  if (pl.state === 'Kansas' && crSea && data.d.length) return PLACES['67601'].headline;
  if (data.d.length && data.wide) return ['Dinosaurs, just down the road.', `No dinosaur fossils are recorded ${data.near}, but these turn up ${data.dnear}.`];
  if (data.d.length) {
    const ps = PERIODS.filter(p => data.d.some(x => x.per === p.id)).map(p => p.name);
    return ['Meet your prehistoric neighbors.', `${ps.length > 1 ? `From the ${ps[0]} to the ${ps[ps.length-1]}` : `From the ${ps[0]}`}, discover dinosaurs recorded ${data.dnear}.`];
  }
  if (pl.state === 'Hawaii') return ['These islands are younger than the dinosaurs.', 'Hawaii’s volcanic islands rose from the Pacific long after the dinosaurs were gone, so there are no dinosaur fossils to find.'];
  if (pl.sea && !xs.length && !data.t.length) return ['Nothing but open water.', `No fossils are recorded ${data.dnear}. The deep ocean floor is young rock, and few fossils are ever collected from it. Try a spot along a coastline.`];
  if (!xs.length && !data.t.length) return ['No dinosaurs on record here yet.', `The Paleobiology Database doesn’t list dinosaur fossils ${data.dnear}. Fossil records follow where paleontologists have searched and published, so many regions are still blank. That can change as new finds come in.`];
  if (data.t.length) return ['Only their footprints remain.', `No dinosaur bones have been recorded ${data.dnear}, but dinosaurs left tracks in the rocks nearby.`];
  if (oldSea >= ice) return ['Before the dinosaurs, this was a sea.', `No dinosaur fossils have been recorded ${data.dnear}. Many of the rocks here are older than the dinosaurs. They formed on the floor of warm, shallow seas full of very different animals.`];
  return ['No dinosaurs here. Giants came later.', `No dinosaur fossils have been recorded ${data.dnear}. Many of the rocks here formed after the dinosaurs were gone, but the Ice Age left a remarkable record of its own.`];
}

const SOURCE = {
  live: 'Live from the Paleobiology Database',
  saved: 'You’re offline · showing results saved on this device',
  snapshot: 'You’re offline · showing records saved in October 2026, statewide',
};

function renderLoading(pl, error){
  app.innerHTML = `<div class="results">
  <div class="ctxrow"><div class="crumbs">${ic('pin')}<span>${placeLine(pl)}</span></div>
    <button class="linkbtn" data-go="home">${ic('gps')}Change location</button></div>
  ${error ? `<div class="empty"><h3>We couldn’t reach the fossil records</h3><p>${navigator.onLine === false && !isUS(pl) ? 'You’re offline, and this place hasn’t been looked up on this device before. Connect and try again.' : 'The Paleobiology Database didn’t respond. Check your connection and try again.'}</p>
    <div class="chips"><button class="chip" id="retry">Try again</button></div></div>`
  : `<div class="res-head"><div><h1>Searching deep time…</h1><p>Looking up fossil records within ${dist(pl, RADIUS)}${pl.town ? ' of ' + pl.town : ''}.</p></div></div>
    <div class="cards" aria-hidden="true">${'<div class="card skel"><div class="art"></div><div class="card-body"><i></i><i></i><i></i></div></div>'.repeat(6)}</div>`}</div>`;
  document.getElementById('retry')?.addEventListener('click', () => open(place, {history:false}));
}

function renderResults(){
  const pl = place, data = DATA;
  if (!data || data.error) return renderLoading(pl, data?.error);
  const [h, sub] = headlineFor(pl, data);
  const counts = Object.fromEntries(PERIODS.map(p => [p.id, data.d.filter(x => x.per === p.id).length]));
  const shown = sorted(data.d.filter(x => inRange(x.per)));
  const active = PERIODS.filter(p => inRange(p.id));
  const all = rng[0] === 0 && rng[1] === 2;
  const xs = Object.entries(data.x).filter(([k]) => INSTEAD[k]).sort((a,b) => b[1]-a[1]);
  const xcards = list => list.map(([k,n]) => { const it = INSTEAD[k]; return `<button class="xcard" data-x="${k}">${XART[k] ? `<div class="art"><img src="art/${XART[k]}.jpg" alt="${it.name} illustration" loading="lazy"></div>` : `<div class="art pending"><span class="ghost">${it.name}</span><span class="note">Illustration coming</span></div>`}<div class="xbody"><span class="tag ${it.era}">${it.tag}</span><h3>${it.name}</h3><p>${it.text}</p><span class="n">${it.when} · ${n} record${n>1?'s':''} ${data.near}</span></div></button>`; }).join('');
  const loc = placeLine(pl);

  let html = `
  <div class="ctxrow"><div class="crumbs">${ic('pin')}<span>${loc}</span><span>/</span><span>${data.region}</span></div>
    <button class="linkbtn" data-go="home">${ic('gps')}Change location</button></div>
  <div class="res-head"><div><h1>${h}</h1><p>${sub}</p></div><span class="eyebrow">Regional field guide</span></div>
  <div class="source ${data.source}">${ic(data.source === 'live' ? 'book' : 'info')}${SOURCE[data.source]}</div>`;

  if (data.d.length) {
    html += `
    <section class="panel" aria-label="Filter by period">
      <div class="panel-top"><div class="ptitle">${ic('sliders')}<b>Explore by period</b><span class="d-only">Drag the handles to travel through time</span><span class="m-only">Tap a period to focus on it</span></div>
        <button class="selall" id="selall" role="checkbox" aria-checked="${all}"><span class="box">${ic('check')}</span>Select all</button></div>
      <div class="range">
        <div class="periods">${PERIODS.map(p => `<button class="per ${p.id}${counts[p.id] ? '' : ' nodata'}" data-per="${p.id}" aria-pressed="${inRange(p.id)}">
          <span class="pm"><span class="pn">${p.name}</span><span class="pa">${Math.round(p.from)}–${Math.round(p.to)} Ma</span></span><span class="pc">${counts[p.id]} dinosaur${counts[p.id] === 1 ? '' : 's'}</span></button>`).join('')}</div>
        <div class="track" id="track"><div class="fill" style="left:${rng[0]/3*100}%;right:${100-(rng[1]+1)/3*100}%"></div>
          <button class="handle" data-h="0" style="left:${rng[0]/3*100}%" aria-label="Oldest period shown: ${PERIODS[rng[0]].name}"></button>
          <button class="handle" data-h="1" style="left:${(rng[1]+1)/3*100}%" aria-label="Newest period shown: ${PERIODS[rng[1]].name}"></button></div>
        <div class="scale"><span>${Math.round(PERIODS[rng[0]].from)} million years ago</span><span>${Math.round(PERIODS[rng[1]].to)} million years ago</span></div>
      </div>
    </section>
    <div class="bar"><div class="count">${shown.length} dinosaur${shown.length === 1 ? '' : 's'}<span>${all ? 'All periods selected' : active.map(p => p.name).join(' + ')}</span></div>
      <label class="sort" for="sort">Sort by <select id="sort">${[['featured','Featured'],['records','Most records'],['oldest','Oldest first'],['newest','Newest first'],['az','A–Z']].map(([v,t]) => `<option value="${v}" ${v===sortBy?'selected':''}>${t}</option>`).join('')}</select></label></div>
    ${shown.length ? `<div class="cards">${shown.map(x => card(x)).join('')}</div>` : `<div class="empty"><h3>No dinosaurs in this stretch of time</h3><p>Nothing is recorded here for the ${active.map(p => p.name).join(' or ')}. Drag the handles or tap Select all to widen the range.</p></div>`}
    <div class="foot-note">${ic('info')}<span>A regional snapshot, not a fossil-site map. Records come from many sites and rock formations ${data.dnear}.</span></div>`;
  }

  if (data.t.length) html += `
    <section class="section feature"><img class="feat-art" src="art/track.jpg" alt="Three-toed dinosaur footprint pressed into a slab of rock"><div><span class="eyebrow">Footprints</span><h2>They walked right here.</h2>
      <p>Fossil tracks get their own names, because it’s rarely certain which dinosaur made them.</p>
      <div class="tracks">${data.t.map(([g,n,f]) => `<div class="track-chip"><b>${g}</b><span>${f[0] ? f[0] + ' Formation · ' : ''}${n} record${n>1?'s':''}</span></div>`).join('')}</div></div></section>`;

  if (data.e.length) html += `
    <section class="section"><span class="eyebrow">Eggshell</span><h2>Nests left behind</h2>
      <p>Fossil eggs are named by their shell structure, separately from the dinosaurs that laid them.</p>
      <div class="tracks">${data.e.map(([g,n,f]) => `<div class="track-chip"><b>${g}</b><span>${f[0] ? f[0] + ' Formation · ' : ''}${n} record${n>1?'s':''}</span></div>`).join('')}</div></section>`;

  const isCr = k => /^Cretaceous/.test(INSTEAD[k].tag);
  const crSea = xs.filter(([k]) => INSTEAD[k].era === 'sea' && isCr(k)), oldSea = xs.filter(([k]) => INSTEAD[k].era === 'sea' && !isCr(k)), ice = xs.filter(([k]) => INSTEAD[k].era === 'ice');
  const lead = !data.d.length && !crSea.length;
  const iceFirst = lead && ice.reduce((s,[,n]) => s+n, 0) > oldSea.reduce((s,[,n]) => s+n, 0);
  if (crSea.length) html += `<section class="section"><span class="eyebrow">Who swam here</span><h2>${pl.state === 'Kansas' ? 'Life in the inland sea' : 'Life in the Cretaceous seas'}</h2>
    <p>While dinosaurs walked the shores, these animals swam and flew over the sea that once covered this region.</p><div class="xcards">${xcards(crSea)}</div></section>`;
  const seaHtml = oldSea.length ? `<section class="section"><span class="eyebrow">${lead && !iceFirst ? 'What lived here instead' : 'Other ancient seas'}</span><h2>${lead && !iceFirst ? 'Creatures of the ancient seas' : 'Life in other ancient seas'}</h2>
    <p>Fossil records of sea life ${data.near}, from long before or after the dinosaurs.</p><div class="xcards">${xcards(oldSea)}</div></section>` : '';
  const iceHtml = ice.length ? `<section class="section"><span class="eyebrow">${iceFirst ? 'What lived here instead' : 'Much later'}</span><h2>The Ice Age giants</h2>
    <p>Long after the dinosaurs, these animals left fossils ${data.near}.</p><div class="xcards">${xcards(ice)}</div></section>` : '';
  html += iceFirst ? iceHtml + seaHtml : seaHtml + iceHtml;

  if (!data.d.length && !pl.sea) html += `<section class="birds"><img src="art/birds.jpg" alt="Two sandhill cranes wading in a marsh"><div class="btxt"><span class="eyebrow">Plot twist</span><h2>Your local dinosaurs have feathers.</h2>
    <p>Birds are living dinosaurs, descended from small feathered theropods. The crane in the marsh and the sparrow at the feeder are your prehistoric neighbors, still here.</p></div></section>`;

  if (!data.d.length && !xs.length && !pl.sea) html += `<div class="empty"><h3>No fossil records here yet</h3><p>The database doesn’t list dinosaur or sea-creature records ${data.near}. That can change as more finds are published.</p>
    <div class="chips"><button class="chip" data-zip="80401">Explore Golden, CO instead</button></div></div>`;

  if (pl.sea && !data.d.length && !xs.length) html += `<div class="empty"><h3>Head for dry land</h3><p>These regions are famous for dinosaur fossils.</p>
    <div class="chips">${WORLD.map(([n, lat, lng]) => `<button class="chip" data-at="${lat},${lng}" data-name="${n}">${n}</button>`).join('')}</div></div>`;

  if (pl.sites?.length) html += `<section class="section"><span class="eyebrow">See them in person</span><h2>Museums and sites nearby</h2><p>Places to see real fossils from this area.</p>
    <div class="sites">${pl.sites.map(([n,s]) => `<div class="site"><b>${n}</b><span>${s}</span></div>`).join('')}</div></section>`;

  app.innerHTML = `<div class="results">${html}</div>`;
  const redraw = () => go('results', {keepScroll:true});
  // Tap a period to focus on it; tap it again to bring every period back.
  app.querySelectorAll('[data-per]').forEach(b => b.addEventListener('click', () => {
    const i = PERIODS.findIndex(p => p.id === b.dataset.per);
    rng = rng[0] === i && rng[1] === i ? [0, 2] : [i, i]; redraw();
  }));
  document.getElementById('selall')?.addEventListener('click', () => { rng = [0, 2]; redraw(); });
  // Handles snap to period boundaries (0–3); the range always keeps at least one period.
  const setEdge = (h, edge) => {
    const next = h === 0 ? [Math.min(edge, rng[1]), rng[1]] : [rng[0], Math.max(edge - 1, rng[0])];
    if (next[0] !== rng[0] || next[1] !== rng[1]) { rng = next; redraw(); return true; }
  };
  app.querySelectorAll('.handle').forEach(el => {
    const h = +el.dataset.h;
    el.addEventListener('keydown', e => {
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
      if (!d) return; e.preventDefault();
      if (setEdge(h, (h === 0 ? rng[0] : rng[1] + 1) + d)) app.querySelector(`.handle[data-h="${h}"]`)?.focus();
    });
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      const move = ev => {
        const r = document.getElementById('track').getBoundingClientRect();
        setEdge(h, Math.max(0, Math.min(3, Math.round((ev.clientX - r.left) / r.width * 3))));
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', () => document.removeEventListener('pointermove', move), {once:true});
    });
  });
  document.getElementById('sort')?.addEventListener('change', e => { sortBy = e.target.value; go('results', {keepScroll:true}); });
}

/* ---------- detail ---------- */
function renderDetail(){
  const data = DATA, x = data?.d?.find(d => d.g === current);
  if (!x) return go('results', {replace:true});
  const G = GUIDE[x.g], per = PERIODS.find(p => p.id === x.per);
  const nearName = place.town || place.state;
  const forms = x.f.length ? x.f.map(f => f + ' Formation').join(', ') : 'Not recorded';
  const stats = G ? G.stats : [['Group', GROUPS[x.grp][0], x.fam || 'Family not recorded'],['Records here', String(x.n), data.dnear.replace(/^\w/, c => c.toUpperCase())],['Diet', x.diet, 'Based on its group'],['Named', x.att ? x.att.replace(/^\(|\)$/g,'') : '—', 'First scientific description']];
  const why = G?.why?.[place.key] || `${x.g} is known here from the ${forms}. The Paleobiology Database lists ${x.n} record${x.n>1?'s':''} of it ${data.dnear}.`;
  const more = G?.more || [`A ${GROUPS[x.grp][0].toLowerCase()} dinosaur`, GROUP_TEXT[x.grp]];
  const peers = sorted(data.d.filter(d => d.per === x.per && d.g !== x.g)).slice(0,3);
  app.innerHTML = `<div class="detail">
  <div class="d-top"><div class="crumbs"><button class="back" data-go="results">${ic('back')}Back to ${data.d.length} dinosaurs</button><span>/ ${placeName(place)} · ${data.region}</span></div><span class="eyebrow">Species field guide</span></div>
  <div class="d-head"><div><div class="row"><span class="tag blue">${x.sub}</span><span>${x.fam || GROUPS[x.grp][0]}</span></div>
    <h1>${x.g}</h1><p class="sci">${G ? `${G.sci} · ${G.mean}` : (x.sci || x.att)}</p></div>
    <span class="rec">${ic('pin')}Recorded ${data.dnear.replace(/ of .*$/, '')}</span></div>
  <div class="d-grid">
    <div class="plate"><span class="lbl">${G?.sci || x.g}</span>${ART[x.g] ? `<button class="expand" id="expand" aria-label="View larger">${ic('expand')}</button>` : ''}
      ${artBox(x, false)}${ART[x.g] ? `<span class="credit">${ic('pencil')}Life reconstruction · Coloration is interpretive</span>` : silFor(x) ? `<span class="credit">${ic('pencil')}${silFor(x)[3] ? `Silhouette of a related ${silFor(x)[3]} · ` : 'Silhouette · '}${silFor(x)[1]} · ${silFor(x)[2]} · via PhyloPic</span>` : ''}</div>
    <aside class="glance"><span class="eyebrow">At a glance</span><h2>${G?.title || `${GROUPS[x.grp][0]} of the ${x.sub}.`}</h2><p>${G?.text || GROUP_TEXT[x.grp]}</p>
      <dl class="facts" style="margin:0"><div><dt>Dinosaur type</dt><dd>${GROUPS[x.grp][0]} · ${x.diet}</dd></div><div><dt>Lived</dt><dd>${fmtMa(x.ea, x.la)}</dd></div><div><dt>Rock record</dt><dd>${forms}</dd></div><div><dt>Records in this area</dt><dd>${x.n}</dd></div></dl></aside>
  </div>
  <div class="stats">${stats.map(([k,v,s]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`).join('')}</div>
  <div class="story">
    <div><h2>${ic('map')}Why it appears near ${nearName}</h2><p>${why}</p><small>Regional evidence, not a claim of fossils ${place.zip ? 'within ZIP code ' + place.zip : 'at your exact location'}.</small></div>
    <div><h2>${more[0]}</h2><p>${more[1]}</p>
      <div class="links"><a href="?find=${x.g}" data-find="${x.g}">Everywhere it’s been found ${ic('map')}</a><a href="https://paleobiodb.org/classic/checkTaxonInfo?taxon_name=${encodeURIComponent(x.g)}" target="_blank" rel="noopener">Fossil records ${ic('out')}</a><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(x.g)}" target="_blank" rel="noopener">Further reading ${ic('out')}</a></div></div>
  </div>
  ${peers.length ? `<section class="related"><div class="morehead"><span class="eyebrow">More from the ${per.name}, ${data.dnear}</span><span>Shared region and period</span></div><div class="cards mini">${peers.map(p => card(p, true)).join('')}</div></section>` : ''}</div>`;
  document.getElementById('expand')?.addEventListener('click', () => {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.setAttribute('role','dialog'); lb.setAttribute('aria-label', x.g + ' illustration');
    lb.innerHTML = `<img src="art/${ART[x.g]}.jpg" alt="${x.g} illustration"><button>Close</button>`;
    const close = () => { lb.remove(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    lb.addEventListener('click', close); document.addEventListener('keydown', esc);
    document.body.appendChild(lb); lb.querySelector('button').focus();
  });
}

/* ---------- non-dinosaur detail ---------- */
function renderX(){
  const k = currentX, it = INSTEAD[k], F = XFACTS[k], data = DATA, n = data?.x?.[k];
  if (!it || !F || !n) return go('results', {replace:true});
  const [stats, moreT, moreP, sci] = F;
  const peers = Object.entries(data.x).filter(([j]) => j !== k && INSTEAD[j]?.era === it.era && INSTEAD[j].tag === it.tag).sort((a,b) => b[1]-a[1]).slice(0,3);
  const why = `The Paleobiology Database lists ${n} ${it.name.toLowerCase()} record${n>1?'s':''} ${data.near}, ${it.era === 'ice' ? 'from the last Ice Age' : 'from rocks laid down in an ancient sea'}.`;
  app.innerHTML = `<div class="detail">
  <div class="d-top"><div class="crumbs"><button class="back" data-go="results">${ic('back')}Back to results</button><span>/ ${placeName(place)}</span></div><span class="eyebrow">Field guide</span></div>
  <div class="d-head"><div><div class="row"><span class="tag ${it.era}">${it.tag}</span><span>${it.when}</span></div>
    <h1>${it.name}</h1><p class="sci">${sci}</p></div>
    <span class="rec">${ic('pin')}Recorded ${data.near.replace(/ of .*$/, '')}</span></div>
  <div class="d-grid">
    <div class="plate"><span class="lbl">${sci}</span>${XART[k] ? `<button class="expand" id="expand" aria-label="View larger">${ic('expand')}</button>` : ''}
      ${XART[k] ? `<div class="art"><img src="art/${XART[k]}.jpg" alt="${it.name} illustration"></div><span class="credit">${ic('pencil')}Life reconstruction · Coloration is interpretive</span>` : `<div class="art pending"><span class="ghost">${it.name}</span><span class="note">Illustration coming</span></div>`}</div>
    <aside class="glance"><span class="eyebrow">At a glance</span><h2>${it.name}</h2><p>${it.text}</p>
      <dl class="facts"><div><dt>Lived</dt><dd>${it.when}</dd></div><div><dt>Setting</dt><dd>${it.tag}</dd></div><div><dt>Records nearby</dt><dd>${n}</dd></div></dl></aside>
  </div>
  <div class="stats">${stats.map(([a,b,c]) => `<div class="stat"><span class="k">${a}</span><span class="v">${b}</span><span class="s">${c}</span></div>`).join('')}</div>
  <div class="story">
    <div><h2>${ic('map')}Why it appears near ${place.town || place.state}</h2><p>${why}</p><small>Regional evidence, not a claim of fossils ${place.zip ? 'within ZIP code ' + place.zip : 'at your exact location'}.</small></div>
    <div><h2>${moreT}</h2><p>${moreP}</p>
      <div class="links"><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(sci.split(' and ')[0])}" target="_blank" rel="noopener">Further reading ${ic('out')}</a></div></div>
  </div>
  ${peers.length ? `<section class="related"><div class="morehead"><span class="eyebrow">More from the same ${it.era === 'ice' ? 'Ice Age' : 'seas'}</span><span>Also recorded ${data.near}</span></div>
    <div class="xcards">${peers.map(([j,m]) => { const o = INSTEAD[j]; return `<button class="xcard" data-x="${j}">${XART[j] ? `<div class="art"><img src="art/${XART[j]}.jpg" alt="${o.name} illustration" loading="lazy"></div>` : ''}<div class="xbody"><span class="tag ${o.era}">${o.tag}</span><h3>${o.name}</h3></div></button>`; }).join('')}</div></section>` : ''}</div>`;
  document.getElementById('expand')?.addEventListener('click', () => {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.setAttribute('role','dialog'); lb.setAttribute('aria-label', it.name + ' illustration');
    lb.innerHTML = `<img src="art/${XART[k]}.jpg" alt="${it.name} illustration"><button>Close</button>`;
    const close = () => { lb.remove(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    lb.addEventListener('click', close); document.addEventListener('keydown', esc);
    document.body.appendChild(lb); lb.querySelector('button').focus();
  });
}

/* ---------- about ---------- */
function renderAbout(){
  const artists = [...new Set([...Object.values(SIL), ...Object.values(FAMSIL), ...Object.values(GRPSIL)].map(v => v[1]).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  app.innerHTML = `<article class="about"><span class="eyebrow">About the data</span><h1>Where these records come from</h1>
  <p>Dino Tracker looks up fossil finds in the Paleobiology Database, a public archive compiled by researchers from published scientific literature. Its data is shared under a Creative Commons Attribution 4.0 license.</p>
  <h2>A place, not a pinpoint</h2><p>Your ZIP code, search or location sets a starting point anywhere in the world. Dino Tracker searches about ${RADIUS} miles (160 km) around it, and up to ${WIDE} miles (400 km) when nothing turns up nearby. Results describe the wider region. They never suggest there are fossils at your address.</p>
  <h2>Your location</h2><p>If you choose “Use my location” or tap the map, the position is rounded to about a kilometer and used only to search. It isn’t stored or shared. Place names and search come from OpenStreetMap’s Nominatim service, ZIP codes from Zippopotam.us, and map tiles from OpenStreetMap.</p>
  <h2>Why some places have no dinosaurs</h2><p>Dinosaurs only fossilize in rocks from their time, about 252 to 66 million years ago, that formed on land or near shore. Much of the eastern and central US is built from older seafloor rock, or from rock too young to hold dinosaurs. Those places show what lived there instead.</p>
  <h2>Looking up a dinosaur</h2><p>Search for any dinosaur by name to see every place the Paleobiology Database records it. Each dot is a fossil site, not a range map: dinosaurs lived far more widely than the places their bones happened to survive and be found. Older records can also reflect identifications that scientists have since questioned.</p>
  <h2>Why the map is uneven</h2><p>The fossil record follows the people who search for it. North America, Europe, Argentina and China have been explored for well over a century, while much of Africa, South Asia and Siberia has barely been surveyed. An empty region usually means “not yet found,” not “nothing lived here.”</p>
  <h2>Footprints, eggs and birds</h2><p>Fossil tracks and eggshell are named separately from the animals that made them, so they appear in their own sections. Birds are dinosaurs too, but this guide focuses on the non-bird dinosaurs, plus a few toothed early birds from the age of dinosaurs.</p>
  <h2>Offline</h2><p>Places you’ve looked up are saved on your device, so they still open without a connection. Elsewhere in the US, Dino Tracker falls back to statewide records saved in October 2026.</p>
  <h2>Illustrations and silhouettes</h2><p>Paintings are from the Dino Tracker specimen collection. Dinosaurs without a painting yet use silhouettes from PhyloPic, an open library of organism silhouettes, limited to images in the public domain or under a Creative Commons Attribution license. When there is no usable silhouette of a dinosaur itself, a close relative is shown and labeled. Silhouettes by ${artists.join(', ')}.</p></article>`;
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-go],[data-zip],[data-at],[data-dino],[data-x],[data-nav],[data-find]');
  if (!t) return;
  if (t.dataset.nav != null) { e.preventDefault(); history.pushState({}, '', t.getAttribute('href')); return route(); }
  if (t.dataset.find) { e.preventDefault(); mapDino = t.dataset.find; go('home'); return document.querySelector('.mapcard')?.scrollIntoView({block:'start'}); }
  if (t.dataset.zip) { const r = await placeFromZip(t.dataset.zip); if (!r.none) open(r); return; }
  if (t.dataset.at) { const [lat, lng] = t.dataset.at.split(',').map(Number), r = await placeFromCoords(lat, lng); open({...r, town:t.dataset.name?.split(', ')[0] || r.town}); return; }
  if (t.dataset.dino) return go('detail', {dino: t.dataset.dino});
  if (t.dataset.x) return go('xdetail', {x: t.dataset.x});
  if (t.dataset.go === 'results' && !place) return go('home');
  go(t.dataset.go);
});

// Read the address bar: ?zip=80401, ?at=39.76,-105.22, plus &dino= or &x= for a detail page, ?find=Tyrannosaurus for the map, or ?about.
async function route(replace){
  const q = new URLSearchParams(location.search);
  if (q.has('about')) return go('about', {history:false});
  const zip = q.get('zip'), at = q.get('at'), find = q.get('find');
  if (!zip && !at) {
    place = null; mapDino = /^[A-Za-z]{2,40}$/.test(find || '') ? find : null;
    go('home', {history:false});
    if (mapDino) document.querySelector('.mapcard')?.scrollIntoView({block:'start'});
    return;
  }
  const then = q.get('dino') ? 'detail' : q.get('x') ? 'xdetail' : 'results';
  current = q.get('dino'); currentX = q.get('x');
  const same = place && (zip ? place.zip === zip : `${place.lat},${place.lng}` === at);
  if (at && !/^-?[\d.]+,-?[\d.]+$/.test(at)) return go('home', {history:false, replace});
  if (same && DATA && !DATA.error) return go(then, {history:false});
  const pl = zip ? await placeFromZip(zip) : await placeFromCoords(...at.split(',').map(Number));
  if (pl.none) return go('home', {history:false, replace});
  if (then === 'results') return open(pl, {history:false});
  place = pl; view = then; renderLoading(pl);
  open(pl, {then});
}
window.addEventListener('popstate', () => route());
route(true);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
