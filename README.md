# Hannafon

Lokale PWA für Familien-Videoanrufe (V1.05). Vanilla HTML, CSS und JavaScript.

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

- Service-Worker-Cache: `hannafon-v1.05`
- Verstecktes Zurücksetzen: Hannafon-Schriftzug fünf Sekunden gedrückt halten (löscht auch den Familien-Code)
- Empfänger können unten auf Standby „Dieses Gerät trennen“ tippen: nur dieses Gerät, der Familien-Code bleibt
- Mehrere Geräte pro Person: jedes Gerät hat eine eigene ID, ein Anruf klingelt überall, das erste Annehmen gewinnt
- Manifest-Orientation ist `any` (iPhone hochkant für Empfänger, iPad-Querformat über das Layout)
- Das Telefonhörer-Icon ist Heroicons v2 „phone“ (24/solid), MIT-Lizenz; siehe `icons/HEROICONS-LICENSE.txt`
- Adressbuch-Icon: Heroicons v2 „book-open“ (24/solid), MIT. „Zurück zum Familienfoto“: eigenes Icon mit drei angedeuteten Köpfen (`icons/family-heads.svg`)
- Familienfoto, Masken, Namen und Geheimnisse gehören nicht in dieses Repository
- iOS-Statusleiste (V1.05): `apple-mobile-web-app-status-bar-style` ist bewusst `default`. Mit `black-translucent` legt iOS 26 seinen Liquid-Glass-Blur über das Foto und WebKit macht Home-Bildschirm-Apps eine Statusleiste zu kurz (Streifen unten). `theme-color` folgt per JS der Fotofarbe am oberen Rand. iOS übernimmt diese Einstellung nur beim Hinzufügen zum Home-Bildschirm: Icon löschen und neu hinzufügen.
- Kamera/Mikrofon (V1.05): Der iOS-Systemdialog lässt sich nicht abschalten. Die App fragt einmal früh (bei „Das bin ich“ bzw. beim ersten Tippen nach dem Start), stoppt die Spuren sofort und fragt nicht, wenn die Berechtigung schon erteilt ist. Dauerhaft still nur, wenn in den iOS-Einstellungen Kamera und Mikrofon auf „Erlauben“ stehen.
