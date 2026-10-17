<p align="center"><img src="assets/menet_mester_logo.png" alt="Menet Mester" width="420" /></p>

# Menet Mester – útnyilvántartó

Webes útnyilvántartó: törzsadatok (cég, jármű, sofőr), úticélok és utak címkereséssel és automatikus
távolságszámítással, járműnapló (szerviz, műszaki vizsga km-állással), valamint lépésenkénti
nyilvántartás-generátor, ami havi bontású Excelt készít.

## Indítás

Node.js 22.5+ kell (a beépített `node:sqlite` modult használja).

```bash
npm install
npm run dev
```

A felület: http://localhost:5173 (az API a 3001-es porton fut, a Vite proxyzza). Az adatbázis a
`data/menet-mester.db` fájlban jön létre, első indításkor a minta cég, jármű, sofőr és utak betöltődnek.

Éles futtatás: `npm run build && npm start` (az Express szolgálja ki a `dist` mappát is).

## Hogyan működik

- **Címkeresés és távolság:** a gépelés közbeni címjavaslatok a [Photon](https://photon.komoot.io)
  (OpenStreetMap) szolgáltatásból jönnek, a távolság az [OSRM](https://project-osrm.org) útvonaltervezővel
  számolódik; több alternatíva közül a legrövidebbet választjuk. Mindkettő ingyenes, kulcs nélküli
  nyilvános szerver — éles, nagy forgalmú használatra érdemes saját példányt futtatni
  (`PHOTON_URL`, `OSRM_URL` környezeti változók).
- **Kötelező helyszínek:** a generátor a járműnaplóból „kéri le”, hol kellett az autónak lennie.
  A JSZP (szerviz/vizsga km-állások) nem kínál nyilvános API-t, ezért ezek kézzel rögzíthetők; a
  `server/index.ts` `providers` listája új forrással (pl. gyártói connected car API, GPS flotta) bővíthető.
- **Generálás** (`server/generator.ts`): a km-óra kontrollpontok (kezdő/záró állás, szerviz km-állás,
  saját elvárás) szakaszokra bontják az időszakot; minden szakasz km-ét munkanapokra (hétvége és
  ünnepnapok nélkül) elosztott oda-vissza utakkal tölti ki, a havi min/max figyelembevételével,
  a végén pontos illesztéssel (korlátos hátizsák). Ugyanazzal a seed-del ugyanaz az eredmény.
- **Export** (`server/export.ts`): hónaponként egy munkalap a minta szerinti fejléccel, útlistával,
  összes km-rel és üzemanyagköltséggel (norma × ár).

## Tesztek

```bash
npm test
```
