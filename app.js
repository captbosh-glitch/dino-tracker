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

// Coordinates -> place, rounded to about a kilometer so we never keep an exact position.
async function placeFromCoords(lat, lng){
  lat = +lat.toFixed(2); lng = +lng.toFixed(2);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lng}`, {headers:{'Accept-Language':'en'}});
    const a = (await r.json()).address || {};
    if (a.country_code && a.country_code !== 'us') return {lat, lng, outside:true};
    const st = (a['ISO3166-2-lvl4'] || '').replace('US-', '');
    const state = a.state || Object.keys(ABBR).find(k => ABBR[k] === st) || '';
    return {lat, lng, town:a.city || a.town || a.village || a.hamlet || a.county || '', st, state};
  } catch {
    return {lat, lng, town:'', st:'', state:''};
  }
}

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
  const s = SNAP.STATES[pl.key || pl.state] || {d:[], t:[]};
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
  const isEgg = g => /oolith/i.test(g);
  const name = pl.town || (pl.zip ? `ZIP ${pl.zip}` : 'here');
  const near = L.source === 'snapshot' ? `in ${pl.state}` : `within ${RADIUS} miles of ${name}`;
  const dnear = L.source === 'snapshot' ? near : `within ${L.mi} miles of ${name}`;
  const d = L.d.filter(r => !isEgg(r[0])).map(([g,n,f,ea,la]) => {
    const [grp, fam, att, ttl] = GEN[g] || ['other','','',''];
    const mid = (ea+la)/2, per = periodOf(mid);
    const diet = grp === 'theropod' && OMNI.includes(fam) ? 'Omnivore' : GROUPS[grp][1];
    return {g, n, f, ea, la, grp, fam, att, sci: GUIDE[g]?.sci || ttl || '', per: per.id, sub: subAge(mid), diet};
  });
  return {d, t:L.t, e:L.d.filter(r => isEgg(r[0])), x:L.x, near, dnear, wide:L.mi === WIDE, source:L.source, at:L.at,
    region: L.source === 'snapshot' ? `Across ${pl.state} · saved records` : `${L.mi}-mile radius`};
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

const placeName = pl => pl.town ? `${pl.town}, ${pl.st}` : pl.zip ? `${pl.zip} · ${pl.st}` : pl.st || 'Your area';

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
  else if (place && v !== 'home') {
    if (place.zip) q.set('zip', place.zip); else q.set('at', `${place.lat},${place.lng}`);
    if (v === 'detail') q.set('dino', current);
    if (v === 'xdetail') q.set('x', currentX);
  }
  const s = q.toString().replace(/=(&|$)/, '$1');
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
    <p>Find the dinosaurs that once called your region home. Start with where you are.</p></div>
    <span class="meta-r">Field notes / North America</span></div>
  <div class="home-grid">
    <section class="findcard" aria-labelledby="find-h">
      <div class="fhead"><h2 id="find-h">${ic('pin')}Find your location</h2><p>Use your current location or enter a US ZIP code to explore a region.</p></div>
      <div class="opt"><button class="btn primary" id="gps">${ic('gps')}Use my location</button>
        <div class="hint">Uses GPS · Your browser will ask for permission</div><div id="gps-note" hidden></div></div>
      <div class="or">or explore by ZIP code</div>
      <div class="zipopt"><label class="f" for="zip">US ZIP code</label>
        <div class="zipbox"><input class="zip" id="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="e.g. 80401" value="${z}">${ic('pin')}</div>
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
    <div class="chips">${SAMPLE_ZIPS.map(k => `<button class="chip" data-zip="${k}">${PLACES[k].town}, ${PLACES[k].st}</button>`).join('')}</div></div>
  <div class="guide">
    <div class="ctx"><span class="eyebrow">A place, not a pinpoint</span><p>Your ZIP code sets a regional starting point. Results describe fossil records across the surrounding area, not a fossil site at your address.</p></div>
    <div class="steps">
      <div class="step">${ic('map')}<h4>Start somewhere</h4><p>Choose a location in the United States.</p></div>
      <div class="step">${ic('sliders')}<h4>Travel through time</h4><p>Narrow your discoveries by geologic period.</p></div>
      <div class="step">${ic('note')}<h4>Meet the locals</h4><p>Open a field guide to each dinosaur.</p></div>
    </div>
  </div></div>`;
  const zip = document.getElementById('zip'), out = document.getElementById('zip-out'), find = document.getElementById('find');
  let found = null, seq = 0;
  const check = async () => {
    const v = zip.value.replace(/\D/g,'').slice(0,5); zip.value = v;
    found = null; find.disabled = true; out.className = 'resolved'; out.textContent = '';
    if (v.length < 5) return;
    const my = ++seq; out.textContent = 'Looking up ZIP code…';
    const r = await placeFromZip(v);
    if (my !== seq) return;
    if (r.none) { out.textContent = 'We couldn’t find that ZIP code. Check the digits and try again.'; out.classList.add('err'); return; }
    found = r; find.disabled = false;
    out.textContent = r.offline ? `${r.state} · you’re offline, so results cover the whole state` : `${r.town}, ${r.state}`;
  };
  zip.addEventListener('input', check);
  zip.addEventListener('keydown', e => { if (e.key === 'Enter' && found) open(found); });
  find.addEventListener('click', () => found && open(found));
  document.getElementById('gps').addEventListener('click', () => {
    const n = document.getElementById('gps-note');
    n.hidden = false; n.className = 'notice';
    // Explain before the browser asks, so the permission prompt is never a surprise.
    n.innerHTML = `<div><b>Find fossils near you</b><br>Dino Tracker uses your location once to search a ${RADIUS}-mile area. It’s rounded to about a kilometer and never stored or shared.</div>
      <div class="chips"><button class="chip" id="gps-go">Continue</button><button class="chip" id="gps-no">Use a ZIP code instead</button></div>`;
    document.getElementById('gps-no').onclick = () => { n.hidden = true; zip.focus(); };
    document.getElementById('gps-go').onclick = () => {
      if (!navigator.geolocation) { n.innerHTML = '<div>This browser can’t share its location. Enter a ZIP code instead.</div>'; return; }
      n.innerHTML = '<div>Finding your location…</div>';
      navigator.geolocation.getCurrentPosition(async pos => {
        const pl = await placeFromCoords(pos.coords.latitude, pos.coords.longitude);
        if (pl.outside) { n.innerHTML = '<div><b>Dino Tracker covers the United States for now.</b> Try a US ZIP code or one of the sample places.</div>'; return; }
        open(pl);
      }, err => {
        n.innerHTML = err.code === 1
          ? '<div><b>Location is turned off for this site.</b> You can allow it in your browser settings, or enter a ZIP code instead.</div>'
          : '<div><b>We couldn’t get your location.</b> Check your signal and try again, or enter a ZIP code.</div>';
      }, {enableHighAccuracy:false, timeout:15000, maximumAge:600000});
    };
  });
  if (zip.value) check();
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
  if (!xs.length && !data.t.length) return ['No dinosaurs on record here yet.', `The Paleobiology Database doesn’t list dinosaur fossils ${data.dnear}. That can change as new finds are published.`];
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
  const loc = [pl.zip, pl.town ? `${pl.town}, ${pl.state}` : pl.state].filter(Boolean).join(' · ');
  app.innerHTML = `<div class="results">
  <div class="ctxrow"><div class="crumbs">${ic('pin')}<span>${loc || 'Your location'}</span></div>
    <button class="linkbtn" data-go="home">${ic('gps')}Change location</button></div>
  ${error ? `<div class="empty"><h3>We couldn’t reach the fossil records</h3><p>The Paleobiology Database didn’t respond. Check your connection and try again.</p>
    <div class="chips"><button class="chip" id="retry">Try again</button></div></div>`
  : `<div class="res-head"><div><h1>Searching deep time…</h1><p>Looking up fossil records within ${RADIUS} miles${pl.town ? ' of ' + pl.town : ''}.</p></div></div>
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
  const loc = [pl.zip, pl.town ? `${pl.town}, ${pl.state}` : pl.state].filter(Boolean).join(' · ');

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

  if (!data.d.length) html += `<section class="birds"><img src="art/birds.jpg" alt="Two sandhill cranes wading in a marsh"><div class="btxt"><span class="eyebrow">Plot twist</span><h2>Your local dinosaurs have feathers.</h2>
    <p>Birds are living dinosaurs, descended from small feathered theropods. The crane in the marsh and the wild turkey in the woods are your prehistoric neighbors, still here.</p></div></section>`;

  if (!data.d.length && !xs.length) html += `<div class="empty"><h3>No fossil records here yet</h3><p>The database doesn’t list dinosaur or sea-creature records ${data.near}. That can change as more finds are published.</p>
    <div class="chips"><button class="chip" data-zip="80401">Explore Golden, CO instead</button></div></div>`;

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
  <div class="d-top"><div class="crumbs"><button class="back" data-go="results">${ic('back')}Back to ${data.d.length} dinosaurs</button><span>/ ${nearName}${place.town ? ', ' + place.state : ''} · ${data.region}</span></div><span class="eyebrow">Species field guide</span></div>
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
      <div class="links"><a href="https://paleobiodb.org/classic/checkTaxonInfo?taxon_name=${encodeURIComponent(x.g)}" target="_blank" rel="noopener">Fossil records ${ic('out')}</a><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(x.g)}" target="_blank" rel="noopener">Further reading ${ic('out')}</a></div></div>
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
  <h2>A place, not a pinpoint</h2><p>Your ZIP code or location sets a starting point. Dino Tracker searches about ${RADIUS} miles around it, and up to ${WIDE} miles when nothing turns up nearby. Results describe the wider region. They never suggest there are fossils at your address.</p>
  <h2>Your location</h2><p>If you choose “Use my location,” your position is rounded to about a kilometer and used only to search. It isn’t stored or shared. Town names come from OpenStreetMap’s Nominatim service and ZIP codes from Zippopotam.us.</p>
  <h2>Why some places have no dinosaurs</h2><p>Dinosaurs only fossilize in rocks from their time, about 252 to 66 million years ago, that formed on land or near shore. Much of the eastern and central US is built from older seafloor rock, or from rock too young to hold dinosaurs. Those places show what lived there instead.</p>
  <h2>Footprints, eggs and birds</h2><p>Fossil tracks and eggshell are named separately from the animals that made them, so they appear in their own sections. Birds are dinosaurs too, but this guide focuses on the non-bird dinosaurs, plus a few toothed early birds from the age of dinosaurs.</p>
  <h2>Offline</h2><p>Places you’ve looked up are saved on your device, so they still open without a connection. Elsewhere, Dino Tracker falls back to statewide records saved in October 2026.</p>
  <h2>Illustrations and silhouettes</h2><p>Paintings are from the Dino Tracker specimen collection. Dinosaurs without a painting yet use silhouettes from PhyloPic, an open library of organism silhouettes, limited to images in the public domain or under a Creative Commons Attribution license. When there is no usable silhouette of a dinosaur itself, a close relative is shown and labeled. Silhouettes by ${artists.join(', ')}.</p></article>`;
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-go],[data-zip],[data-dino],[data-x]');
  if (!t) return;
  if (t.dataset.zip) { const r = await placeFromZip(t.dataset.zip); if (!r.none) open(r); return; }
  if (t.dataset.dino) return go('detail', {dino: t.dataset.dino});
  if (t.dataset.x) return go('xdetail', {x: t.dataset.x});
  if (t.dataset.go === 'results' && !place) return go('home');
  go(t.dataset.go);
});

// Read the address bar: ?zip=80401, ?at=39.76,-105.22, plus &dino= or &x= for a detail page, or ?about.
async function route(replace){
  const q = new URLSearchParams(location.search);
  if (q.has('about')) return go('about', {history:false});
  const zip = q.get('zip'), at = q.get('at');
  if (!zip && !at) { place = null; return go('home', {history:false}); }
  const then = q.get('dino') ? 'detail' : q.get('x') ? 'xdetail' : 'results';
  current = q.get('dino'); currentX = q.get('x');
  const same = place && (zip ? place.zip === zip : `${place.lat},${place.lng}` === at);
  if (same && DATA && !DATA.error) return go(then, {history:false});
  const pl = zip ? await placeFromZip(zip) : await placeFromCoords(...at.split(',').map(Number));
  if (pl.none || pl.outside) return go('home', {history:false, replace});
  if (then === 'results') return open(pl, {history:false});
  place = pl; view = then; renderLoading(pl);
  open(pl, {then});
}
window.addEventListener('popstate', () => route());
route(true);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
