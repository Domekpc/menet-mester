# Telepítés Vercelre (ingyenes)

Az alkalmazás a Vercelen fut, az adatok egy ingyenes Neon Postgres adatbázisban vannak, amit a Vercel
felületéről adsz hozzá. Domain nem kell: a cím `https://<projektnév>.vercel.app` lesz. Az oldal
jelszóval védett.

Helyben minden marad a régiben: `npm run dev` a `data/menet-mester.db` SQLite-fájllal dolgozik.

## 1. Projekt létrehozása

1. Lépj be a [vercel.com](https://vercel.com) oldalon a GitHub-fiókoddal (Hobby, ingyenes csomag).
2. **Add New… → Project**, és válaszd a `Domekpc/menet-mester` repót (**Import**).
3. A beállításokat hagyd, ahogy vannak (a `vercel.json` mindent megad), és kattints a **Deploy** gombra.
   Az első telepítés még adatbázis nélkül indul, ezért az oldal hibát fog mutatni — ez a 2. lépés után rendbe jön.

## 2. Adatbázis hozzáadása

1. A projektben: **Storage → Create Database**, majd a Marketplace-ből a **Neon** (Serverless Postgres).
2. Csomag: **Free**. Régió: **Frankfurt (eu-central-1)** — a szerver is Frankfurtban fut, így gyors.
3. **Connect Project** ablak:
   - Environments: **Production, Preview** (elég),
   - Create Database Branch: **egyik se** legyen bejelölve,
   - Custom Environment Variable Prefix: **`DATABASE`** — így lesz a változó neve `DATABASE_URL`,
     amit az alkalmazás keres,
   - Sensitive: maradhat bekapcsolva.

Az első induláskor az alkalmazás létrehozza a táblákat, és betölti az alapadatokat (Ernivill Kft.,
Mercedes GLC, Eckhardt Tímea, a mintautak).

## 3. Jelszó beállítása

**Settings → Environment Variables**, mindkettő a **Production** környezetre:

| Név | Érték |
|---|---|
| `APP_PASSWORD` | a jelszó, amivel belépsz |
| `AUTH_SECRET` | egy hosszú véletlen szöveg (pl. a `openssl rand -base64 32` parancs kimenete) |

Ha az `AUTH_SECRET`-et vagy a jelszót megváltoztatod, mindenki kijelentkezik.

Ezután **Deployments → a legutóbbi → ⋯ → Redeploy**, hogy az új beállítások érvénybe lépjenek.

## 4. A meglévő adatok átköltöztetése (egyszer)

A gépeden lévő adatokat (úticélok, utak, sablonok, járműnapló, mentett nyilvántartások) így
másolod fel:

1. A Vercelen a **Storage** fülön nyisd meg a Neon adatbázist → **Open in Neon** → **Connect**, és másold ki
   a kapcsolódási címet (`postgresql://…`). (Ha a változó „Sensitive”, a Vercelben nem olvasható vissza.)
2. A projekt mappájában, a saját terminálodban:

```bash
DATABASE_URL="ide-a-kimásolt-cím" npm run migrate:pg
```

   Ez csak kiírja, mi kerülne át. Ha rendben van, futtasd újra így:

```bash
DATABASE_URL="ide-a-kimásolt-cím" npm run migrate:pg -- --yes
```

A felhőben lévő táblák tartalma ekkor felülíródik a helyi adatokkal (a kezdő alapadatok is).

## 5. Kész

Nyisd meg a `https://<projektnév>.vercel.app` címet, és lépj be a jelszóval. Minden új `git push` a
`main` ágra magától új telepítést indít.

## Költségek és korlátok

- A Vercel Hobby és a Neon Free csomag is ingyenes, bankkártya nem kell. Egy felhasználónak bőven elég.
- A Neon ingyenes adatbázisa pár perc tétlenség után „elalszik”; az első kérés ilyenkor 1–2 másodperccel
  lassabb.
- A Vercel Hobby csomag a feltételei szerint személyes, nem üzleti használatra szól.
- A címkereső (Photon) és az útvonaltervező (OSRM) ingyenes nyilvános szolgáltatás; a találatokat az
  adatbázis megjegyzi, így minden címet csak egyszer kérdez le.
