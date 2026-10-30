"""
Collects fossil news for the News page (built on the Playoff Beard collector).

Reads the feeds below, keeps fossil stories from the last 30 days, groups the same story
from different outlets, and tags each with the animals it names:
  data/news-articles.json  every article seen in the last 30 days (the collector's memory)
  data/news.json           the grouped stories the app reads, plus the latest videos from a few YouTube channels
Run it with `python3 tools/news.py`. It needs only the Python standard library.
"""
import hashlib, html, json, os, re, sys, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'news-articles.json')
OUT = os.path.join(ROOT, 'data', 'news.json')
UA = 'DinoTracker/1.0 (+https://captbosh-glitch.github.io/dino-tracker/)'
KEEP_DAYS = 30

# Checked Oct 29, 2026. Google News adds outlets the science feeds miss, but sends no summaries.
FEEDS = {
    'ScienceDaily': 'https://www.sciencedaily.com/rss/fossils_ruins/dinosaurs.xml',
    'ScienceDaily ': 'https://www.sciencedaily.com/rss/fossils_ruins/paleontology.xml',
    'Phys.org': 'https://phys.org/rss-feed/biology-news/paleontology-fossils/',
    'Live Science': 'https://www.livescience.com/feeds/tag/dinosaurs',
    'Google News': 'https://news.google.com/rss/search?q=dinosaur+fossil+when:30d&hl=en-US&gl=US&ceid=US:en',
}
# Outlets that lead a story when several report it, best first.
TRUSTED = ['ScienceDaily', 'Live Science', 'BBC', 'Natural History Museum', 'Smithsonian Magazine', 'Nature',
           'National Geographic', 'Scientific American', 'New Scientist', 'Phys.org', 'Sci.News', 'AP News', 'Reuters', 'CBS News']
SKIP_SOURCES = {'Facebook', 'Instagram', 'X', 'TikTok', 'YouTube', 'Reddit', 'Pinterest'}

FOSSIL = re.compile(r'dinosaur|\bdino\b|fossil|paleontolog|palaeontolog|jurassic|cretaceous|triassic|permian|'
                    r'devonian|cambrian|extinct|prehistoric|pterosaur|mosasaur|plesiosaur|trilobite|ammonite|mammoth|mastodon', re.I)
JUNK = re.compile(r'jurassic world|jurassic park|movie|film|box office|trailer|toy|lego|halloween|costume|restaurant|'
                  r'theme park|ticket|crossword|wordle|video game|\bnfl\b|\bnba\b|stock|crypto', re.I)
# Human evolution and archaeology are their own fields; the app is about the animals.
HUMAN = re.compile(r'neanderthal|denisovan|hominin|homo (?:erectus|sapiens|naledi)|archaeolog|pyramid|pharaoh|roman|viking|stone age tool', re.I)
DINO_WORDS = re.compile(r'dinosaur|\bdino\b|theropod|sauropod|tyrannosaur|raptor\b|footprint|trackway|dinosaur egg|nest', re.I)

# The featured non-dinosaurs, matched by what news stories call them. Group names only where the
# app's animal is that whole group, so a story about some pterosaur never claims to be about Pteranodon.
XWORDS = {
    r'trilobites?': 'trilobite', r'ammonites?': 'ammonite', r'dunkleosteus': 'dunkleosteus',
    r'sea scorpions?|eurypterids?|eurypterus': 'eurypterus', r'mosasaurs?|mosasaurus|tylosaurus': 'mosasaur',
    r'elasmosaurus': 'elasmosaurus', r'xiphactinus': 'xiphactinus', r'cretoxyrhina|ginsu shark': 'cretoxyrhina',
    r'pteranodon': 'pteranodon', r'archelon': 'archelon', r'megalodon|otodus': 'otodus',
    r'mammoths?': 'mammuthus', r'mastodons?': 'mammut', r'sab(?:er|re)[- ]tooth(?:ed)? cats?|smilodon': 'smilodon',
    r'ground sloths?': 'sloth', r'dimetrodon': 'dimetrodon', r'edaphosaurus': 'edaphosaurus',
    r'eryops': 'eryops', r'diplocaulus': 'diplocaulus',
}
ALIAS = {r'\bT\.?\s?-?rex\b': 'Tyrannosaurus'}
# "A T. rex cousin" or "a mini T. rex" is about some other animal; T. rex is only mentioned.
LIKE = re.compile(r'(cousin|relative|like|mini|smaller|rival|ancestor|lookalike|look-alike)\W+(?:of\W+)?(?:an?\W+)?T\.?\s?-?rex|T\.?\s?-?rex[- ](?:like|cousin|relative)', re.I)

# Ages, to tag a story with its period: [start in millions of years, name].
AGES = [(538.8, 'Cambrian', 'pal'), (485.4, 'Ordovician', 'pal'), (443.8, 'Silurian', 'pal'), (419.2, 'Devonian', 'pal'),
        (358.9, 'Carboniferous', 'pal'), (298.9, 'Permian', 'pal'), (251.9, 'Early Triassic', 'tri'), (247.2, 'Middle Triassic', 'tri'),
        (237, 'Late Triassic', 'tri'), (201.4, 'Early Jurassic', 'jur'), (174.7, 'Middle Jurassic', 'jur'), (161.5, 'Late Jurassic', 'jur'),
        (145, 'Early Cretaceous', 'cre'), (100.5, 'Late Cretaceous', 'cre'), (66, 'Paleocene', 'cen'), (56, 'Eocene', 'cen'),
        (33.9, 'Oligocene', 'cen'), (23.03, 'Miocene', 'cen'), (5.33, 'Pliocene', 'cen'), (2.58, 'Pleistocene', 'cen')]
AGE = re.compile(r'(\d[\d,.]*)[- ](billion|million|thousand)?[- ]?years?[- ](?:old|ago)', re.I)


# YouTube channels, by channel ID (the channel page's About panel: Share channel > Copy channel ID).
# Their official feeds list each channel's 15 latest videos. trusted: a paleontology channel whose teaser
# titles ("They were the first reptiles to return to the water") pass without deep-time words.
CHANNELS = {
    'UCzR-rom72PHN9Zg7RML9EbA': ('PBS Eons', True),
    'UC5bjeIaPZwI-uof6sNbfmpg': ('Ancient Planet', False),
    'UCNSbgDRlAHM55EXMxEKPrmg': ('Stellar', False),
}
VIDEO_DAYS = 90
DEEP = re.compile(r'dinosaur|prehistoric|fossil|paleo|jurassic|cretaceous|triassic|permian|carboniferous|devonian|silurian'
                  r'|ordovician|cambrian|ediacaran|pangaea|gondwana|rodinia|panthalassa|(?:million|billion) years|extinct'
                  r'|mammoth|mastodon|megafauna|sabre|saber|pterosaur|plesiosaur|ichthyosaur|mosasaur|trilobite|ammonite'
                  r'|megalodon|ice age|t\. ?rex|raptor|sauropod|feathered', re.I)
# Videos about people rather than deep time. "Before Humans Ruled Earth" is still deep time.
PEOPLE = re.compile(r'(?<!before )\bhumans?\b|stone age|ancestors|neandert[h]?al|denisovan|homo |hominin|archaeolog|civili[sz]ation', re.I)
PERIODS = [(r'cambrian', 'Cambrian', 'pal'), (r'ordovician', 'Ordovician', 'pal'), (r'silurian', 'Silurian', 'pal'),
           (r'devonian', 'Devonian', 'pal'), (r'carboniferous', 'Carboniferous', 'pal'), (r'permian', 'Permian', 'pal'),
           (r'triassic|carnian', 'Triassic', 'tri'), (r'jurassic', 'Jurassic', 'jur'), (r'cretaceous', 'Cretaceous', 'cre'),
           (r'paleogene|paleocene|eocene', 'Paleogene', 'cen'), (r'ice age|pleistocene|mammoth', 'Ice Age', 'cen')]


def videos(now):
    """The latest deep-time videos from the channels above, newest first."""
    ns = {'a': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015',
          'm': 'http://search.yahoo.com/mrss/'}
    cutoff = (now - timedelta(days=VIDEO_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')
    out = []
    for cid, (channel, trusted) in CHANNELS.items():
        try:
            req = urllib.request.Request('https://www.youtube.com/feeds/videos.xml?channel_id=' + cid, headers={'User-Agent': UA})
            root = ET.fromstring(urllib.request.urlopen(req, timeout=20).read())
        except Exception as e:
            print(f'  {channel}: {e}', file=sys.stderr)
            continue
        for e in root.findall('a:entry', ns):
            vid, title = e.findtext('yt:videoId', '', ns), html.unescape(e.findtext('a:title', '', ns))
            desc = html.unescape(e.findtext('m:group/m:description', '', ns))
            published = e.findtext('a:published', '', ns)[:19] + 'Z'
            if not vid or published < cutoff or PEOPLE.search(title) or not (trusted or DEEP.search(title + ' ' + desc[:400])):
                continue
            per = next(((name, p) for pat, name, p in PERIODS if re.search(pat, title, re.I)), None)
            out.append({'id': vid, 'title': title, 'channel': channel, 'published': published,
                        'url': 'https://www.youtube.com/watch?v=' + vid, 'about': dinos_in(title),
                        'age': per[0] if per else None, 'per': per[1] if per else None})
    out.sort(key=lambda v: v['published'], reverse=True)
    return out


def load_names():
    gen = json.load(open(os.path.join(ROOT, 'data', 'genera.json'), encoding='utf-8'))
    names = [g for g, v in gen.items() if not v[4] and not re.search(r'oolithus$|ovum$', g) and len(g) > 2]
    # Short names that are also everyday words (Mei, Yi, Beg) only count when capitalized.
    long_ = sorted([n for n in names if len(n) >= 7], key=len, reverse=True)
    short = sorted([n for n in names if len(n) < 7], key=len, reverse=True)
    return (re.compile(r'\b(' + '|'.join(map(re.escape, long_)) + r')\b', re.I),
            re.compile(r'\b(' + '|'.join(map(re.escape, short)) + r')\b'), {n.lower(): n for n in names})


RX_LONG, RX_SHORT, CANON = load_names()


def clean(text, limit=280):
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text or ''))
    text = re.sub(r'\s+', ' ', text).strip()
    return text if len(text) <= limit else text[:limit].rsplit(' ', 1)[0] + '…'


def dinos_in(text):
    found = []
    for m in list(RX_LONG.finditer(text)) + list(RX_SHORT.finditer(text)):
        g = CANON.get(m.group(1).lower())
        if g and g not in found:
            found.append(g)
    for pat, g in ALIAS.items():
        if re.search(pat, text, re.I) and g not in found:
            found.append(g)
    return found


def tag(title, summary):
    """The animals a story is about (named in its headline) and the ones it only mentions."""
    about, mentions = dinos_in(title), [g for g in dinos_in(summary)]
    # A headline that names no animal ("…dinosaur with long claws") is about the ones its summary names,
    # except T. rex, which summaries mostly bring up for scale.
    if not about:
        about = [g for g in mentions if g != 'Tyrannosaurus'][:2]
    # A headline naming T. rex next to another tyrannosaur, or as a comparison, is about the other one.
    if 'Tyrannosaurus' in about and (LIKE.search(title) or len(about) > 1):
        about.remove('Tyrannosaurus')
        mentions.insert(0, 'Tyrannosaurus')
    mentions = [g for g in dict.fromkeys(mentions) if g not in about]
    text = title + ' ' + summary
    xs = list(dict.fromkeys(k for pat, k in XWORDS.items() if re.search(r'\b(?:' + pat + r')\b', text, re.I)))
    return about, mentions, xs


def age_of(text):
    m = AGE.search(text)
    if not m:
        return None
    n = float(m.group(1).replace(',', ''))
    unit = (m.group(2) or '').lower()
    ma = n * 1000 if unit == 'billion' else n if unit == 'million' else n / 1000 if unit == 'thousand' else n / 1e6
    if ma > 538.8 or ma < 0.0117:
        return None
    # The youngest period that began before this age. "66 million years old" counts as the Cretaceous's last days.
    for start, name, per in reversed(AGES):
        if ma < start:
            return name, per, round(ma, 3)
    return None


def stamp(e, now):
    t = e.findtext('pubDate') or e.findtext('{http://www.w3.org/2005/Atom}published')
    try:
        return min(parsedate_to_datetime(t).astimezone(timezone.utc), now).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        return now.strftime('%Y-%m-%dT%H:%M:%SZ')


def image_of(item, desc):
    for tag_ in ('{http://search.yahoo.com/mrss/}content', '{http://search.yahoo.com/mrss/}thumbnail', 'enclosure'):
        e = item.find(tag_)
        if e is not None and e.get('url') and (tag_ != 'enclosure' or (e.get('type') or '').startswith('image')):
            return e.get('url')
    m = re.search(r'<img[^>]+src="([^"]+)"', desc or '')
    return m.group(1) if m else None


def fetch(now):
    found = []
    for feed, url in FEEDS.items():
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            root = ET.fromstring(urllib.request.urlopen(req, timeout=25).read())
        except Exception as err:
            print(f'  WARN {feed.strip()}: {err}', file=sys.stderr)
            continue
        for it in root.iter('item'):
            title, link = clean(it.findtext('title'), 220), (it.findtext('link') or '').strip()
            desc, source = it.findtext('description') or '', feed.strip()
            summary = clean(desc)
            if source == 'Google News':
                # Google News titles end in " - Outlet", and its descriptions only repeat the title.
                src = it.find('source')
                m = re.search(r'\s+-\s+([^-]+)$', title)
                source = (src.text.strip() if src is not None and src.text else m.group(1).strip() if m else 'Google News')
                if m:
                    title = title[:m.start()].strip()
                summary = ''
            if not title or not link or source in SKIP_SOURCES:
                continue
            found.append({'id': hashlib.sha1(link.encode()).hexdigest()[:12], 'source': source, 'title': title, 'url': link,
                          'summary': summary, 'image': image_of(it, desc), 'published': stamp(it, now)})
    return found


def words(t):
    stop = set('a an the of in on at to for and or with from by is are was its it this that as new after how why what into over just than more most be has have'.split())
    return {w for w in re.findall(r'[a-z0-9$.]+', t.lower()) if w not in stop and len(w) > 2}


COMMON = set('dinosaur dinosaurs fossil fossils scientists paleontologists species skeleton million year years old ancient rare '
             'discovery discovered found reveals reveal first giant largest world museum study researchers prehistoric meet '
             'photos video watch dino bones bone tooth teeth jurassic cretaceous triassic auction'.split())


def names(title):
    """Distinctive names in a headline (Jodi, Nanotyrannus, Montana), for spotting the same story told differently."""
    # Capitalized words, skipping a headline's opening word unless it's quoted, like ‘Jodi’.
    toks = [m.group(1) for m in re.finditer(r"(?:^|[\s‘'\"“])([A-Z][A-Za-z]{3,})", title) if m.start(1) > 0]
    toks += [g for g in dinos_in(title) if g != 'Tyrannosaurus']
    return {t.lower() for t in toks if t.lower() not in COMMON}


def days(a, b):
    return abs((datetime.fromisoformat(a[:19]) - datetime.fromisoformat(b[:19])).days)


def same(a, w, n, b, wb, nb):
    shared = w & wb
    if len(shared) / max(1, len(w | wb)) >= 0.34 or (len(shared) >= 3 and any(x.startswith('$') for x in shared)):
        return True
    # A shared name plus one more shared word, a few days apart: "Jodi" in two auction headlines.
    return bool(n & nb) and len(shared - n) >= 1 and days(a['published'], b['published']) <= 4


def group(articles):
    """One story per event: headlines are compared one to one, so stories can't snowball."""
    stories = []
    for a in sorted(articles, key=lambda a: a['published']):
        w, n = words(a['title']), names(a['title'])
        home = next((st for st in stories if any(same(a, w, n, b, wb, nb) for b, wb, nb in st['heads'])), None)
        if home:
            home['items'].append(a)
            home['heads'].append((a, w, n))
        else:
            stories.append({'items': [a], 'heads': [(a, w, n)]})
    # Headlines arrive in date order, so a story can split before its linking headline shows up. Merge until stable.
    merged = True
    while merged:
        merged = False
        for i, st in enumerate(stories):
            for other in stories[i + 1:]:
                if any(same(a, w, n, b, wb, nb) for a, w, n in st['heads'] for b, wb, nb in other['heads']):
                    st['items'] += other['items']; st['heads'] += other['heads']
                    stories.remove(other); merged = True
                    break
            if merged:
                break
    out = []
    for st in stories:
        text_t, text_s = ' '.join(a['title'] for a in st['items']), ' '.join(a['summary'] for a in st['items'])
        about, mentions, xs = tag(text_t, text_s)
        # Lead with a headline that names what the story is about, from the most trusted outlet, with a summary if possible.
        rank = lambda a: (not any(g in tag(a['title'], '')[0] for g in about), TRUSTED.index(a['source']) if a['source'] in TRUSTED else len(TRUSTED), -len(a['summary']))
        items = sorted(st['items'], key=rank)
        lead = items[0]
        age = age_of(lead['title']) or age_of(lead['summary']) or age_of(text_t)
        dinoish = bool(about) or bool(DINO_WORDS.search(text_t + ' ' + text_s))
        seen = set()
        more = [{'source': a['source'], 'url': a['url']} for a in items[1:] if not (a['source'] in seen or seen.add(a['source'])) and a['source'] != lead['source']]
        out.append({'id': lead['id'], 'title': lead['title'], 'url': lead['url'], 'source': lead['source'],
                    'summary': lead['summary'] or next((a['summary'] for a in items if a['summary']), ''),
                    'image': next((a['image'] for a in items if a['image']), None),
                    'published': lead['published'], 'first': min(a['published'] for a in items), 'latest': max(a['published'] for a in items),
                    'about': about, 'mentions': mentions, 'x': xs, 'age': age[0] if age else None, 'per': age[1] if age else None,
                    'ma': age[2] if age else None,
                    'kind': 'dino' if dinoish else 'beyond', 'more': more})
    out.sort(key=lambda s: (s['latest'], len(s['more'])), reverse=True)
    return out


def main():
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')
    kept = json.load(open(RAW, encoding='utf-8')) if os.path.exists(RAW) else []
    by_id = {a['id']: a for a in kept}
    for a in fetch(now):
        by_id.setdefault(a['id'], a)
    articles = [a for a in by_id.values() if a['published'] >= cutoff and FOSSIL.search(a['title'] + ' ' + a['summary'])
                and not JUNK.search(a['title']) and not HUMAN.search(a['title'])]
    articles.sort(key=lambda a: a['published'], reverse=True)
    stories = group(articles)
    json.dump(articles, open(RAW, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    vids = videos(now)
    json.dump({'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'stories': stories, 'videos': vids},
              open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(articles)} articles, {len(stories)} stories, {sum(1 for s in stories if s["about"])} name a dinosaur, {len(vids)} videos')


if __name__ == '__main__':
    main()
