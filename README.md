# Dino Tracker

**A field guide to deep time.** Enter a US ZIP code, search for any place on Earth, tap the world map or share your location to meet the dinosaurs recorded within about 100 miles (160 km) of it, plus the animals that came before and after them: trilobites and sail-backed Dimetrodon, mosasaurs, mammoths and more.

Live: https://captbosh-glitch.github.io/dino-tracker/

Concept and product design by Pat David.

Case study: https://captbosh-glitch.github.io/dino-tracker/case-study/

## How it works

- **Places.** US ZIP codes resolve through [Zippopotam.us](https://zippopotam.us). Place-name search and town names come from OpenStreetMap's [Nominatim](https://nominatim.org); search runs only when you press Enter, per its usage policy. "Use my location" and map taps are rounded to about a kilometer. Nothing is stored on a server.
- **World map.** [Leaflet](https://leafletjs.com) with OpenStreetMap tiles, loaded only when the map scrolls into view. `data/hotspots.json` bins every Mesozoic dinosaur record in the database (about 21,700) into 1.5° cells so the map shows where fossils have been found.
- **Timeline.** Results run through five spans of deep time: the Paleozoic, the Triassic, Jurassic and Cretaceous, and the Cenozoic. Each animal that isn't a dinosaur is tagged with the period its local fossils come from (Ordovician, Permian, Pleistocene and so on), worked out from the ages of the nearby records.
- **Animal search.** Type any of about 3,900 dinosaur names, or a featured non-dinosaur like Dimetrodon or Mammoth, (with typo-tolerant suggestions) to plot every site where it has been found, straight from the Paleobiology Database. Each site links to the dinosaur's field guide for that area.
- **Fossil records.** Results come live from the [Paleobiology Database](https://paleobiodb.org) API: non-bird dinosaur occurrences in a 100-mile box (widened to 250 miles when nothing turns up nearby), plus records of 19 featured non-dinosaurs, from trilobites and Dimetrodon to mosasaurs and mammoths, tallied by geologic period.
- **Classification.** `data/genera.json` maps every dinosaur genus in the database to its group (theropod, sauropod and so on), family, author and type species, and flags trace fossils so footprints get their own section. Eggshell taxa (`*oolithus`) are separated the same way.
- **News.** `tools/news.py` collects fossil stories from ScienceDaily, Phys.org, Live Science and Google News every three hours (`.github/workflows/news.yml`; GitHub's scheduler rarely fires, so `tools/mac-timer.sh install` adds a backup timer on the Mac), groups the same story from different outlets, tags each with the animals it names, and writes `data/news.json`. The News page lists them, field guides show “In the news,” and cards get a badge for two weeks. Headlines link to the publisher and open in a new tab. It also reads the YouTube feeds of PBS Eons, Ancient Planet, Stellar and Proper Prehistoric (channel IDs in `CHANNELS`), keeps full-length deep-time videos from the last two years (no Shorts, each title once), and shows them as thumbnail cards that open on YouTube; nothing plays on the site. The News tab shows a red count of stories this browser hasn’t seen.
- **Offline.** A service worker keeps the app and any art it has shown. Each place looked up is saved on the device; elsewhere in the US the app falls back to `data/snapshot.json`, statewide records saved in October 2026.
- **Shareable.** Every screen has an address: `?zip=80401`, `?at=43.57,104.42&dino=Velociraptor`, `?find=Spinosaurus`, `?zip=67601&x=xiphactinus`, `?news`, `?about`.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The app (no build step, no framework) |
| `data.js` | Field-guide text, sample places, art and silhouette credits |
| `data/genera.json` | Dinosaur genus lookup built from the Paleobiology Database, with record counts for ranking search suggestions |
| `data/snapshot.json` | Statewide US records used when offline |
| `data/hotspots.json` | Where dinosaur fossils have been found worldwide, for the map |
| `art/` | Specimen paintings; `art/sil/` holds silhouettes |
| `data/news.json` | Fossil news stories and videos for the News page, refreshed every three hours |
| `tools/news.py`, `.github/workflows/news.yml` | The news collector and the schedule that runs it |
| `tools/mac-timer.sh` | Backup timer that runs the collector from the Mac every three hours |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |

To run it locally, serve the folder with any static server, for example `python3 -m http.server`.

## Credits

- Fossil occurrence data: The Paleobiology Database, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Place names and map tiles: © OpenStreetMap contributors. ZIP codes: Zippopotam.us. Map: Leaflet.
- Paintings: the Dino Tracker specimen collection.
- Silhouettes: [PhyloPic](https://www.phylopic.org), public domain and CC BY images only. Each silhouette is credited to its artist on the dinosaur's page and on the About screen. When no usable silhouette of a genus exists, a labeled silhouette of a close relative is shown.
