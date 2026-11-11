# Hannafon

Lokale PWA für Familien-Videoanrufe (V1.03). Vanilla HTML, CSS und JavaScript.

Live-Test (GitHub Pages + Cloudflare Worker):
https://muellkuebel.github.io/hannafon/
https://hannafon.muellkuebel.workers.dev/api/health

Familienfoto, Masken, Personen-Ausschnitte und Namen liegen **nicht** in diesem Repository. Der Cloudflare Worker liefert sie erst nach einem gültigen Familien-Code aus. Die App fragt den Code beim ersten Öffnen ab oder liest ihn aus einem Einladungslink (`?code=` / `?familie=`) und legt die Bilder danach im Cache Storage ab.

## Lokal starten

Voraussetzungen: Node.js, die private Mediendatei-Ablage neben diesem Ordner, und die Umgebungsvariable `HANNAFON_FAMILY_CODE` (wird nur als SHA-256-Hash mit dem Worker verglichen, nie ins Repo geschrieben).

```bash
npm install
npm run dev
```

Danach: [http://127.0.0.1:4173/hannafon/](http://127.0.0.1:4173/hannafon/) und der Worker auf Port 8787.

```bash
npx playwright install chromium
npm run test:e2e
```

## Hinweise

- Service-Worker-Cache: `hannafon-v1.03`
- Verstecktes Zurücksetzen: Hannafon-Schriftzug fünf Sekunden gedrückt halten (löscht auch den Familien-Code)
- Empfänger können unten auf Standby „Dieses Gerät trennen“ tippen: nur dieses Gerät, der Familien-Code bleibt
- Mehrere Geräte pro Person: jedes Gerät hat eine eigene ID, ein Anruf klingelt überall, das erste Annehmen gewinnt
- Manifest-Orientation ist `any` (iPhone hochkant für Empfänger, iPad-Querformat über das Layout)
- Das Telefonhörer-Icon ist Heroicons v2 „phone“ (24/solid), MIT-Lizenz; siehe `icons/HEROICONS-LICENSE.txt`
- Familienfoto, Masken, Namen und Geheimnisse gehören nicht in dieses Repository
