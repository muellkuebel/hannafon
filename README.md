# Hannafon

Lokale PWA für Familien-Videoanrufe (V1.06). Vanilla HTML, CSS und JavaScript.

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

- Service-Worker-Cache: `hannafon-v1.06`
- Verstecktes Zurücksetzen: die obere rechte Ecke fünf Sekunden gedrückt halten (unsichtbare Fläche, seit V1.06 ohne sichtbaren Hannafon-Schriftzug; löscht auch den Familien-Code). Bei offenem Adressbuch nicht erreichbar.
- Empfänger können unten auf Standby „Dieses Gerät trennen“ tippen: nur dieses Gerät, der Familien-Code bleibt
- Mehrere Geräte pro Person: jedes Gerät hat eine eigene ID, ein Anruf klingelt überall, das erste Annehmen gewinnt
- Manifest-Orientation ist `any` (iPhone hochkant für Empfänger, iPad-Querformat über das Layout)
- Das Telefonhörer-Icon ist Heroicons v2 „phone“ (24/solid), MIT-Lizenz; siehe `icons/HEROICONS-LICENSE.txt`
- Adressbuch-Icon: Heroicons v2 „book-open“ (24/solid), MIT. „Zurück zum Familienfoto“: eigenes Icon mit drei angedeuteten Köpfen (`icons/family-heads.svg`)
- Familienfoto, Masken, Namen und Geheimnisse gehören nicht in dieses Repository
- iOS-Statusleiste (V1.06): `apple-mobile-web-app-status-bar-style` ist `black` (deckend schwarz, helle Uhr/Akku), `theme-color` und Manifest `theme_color` sind fest `#000000` und folgen nicht mehr dem Foto. Nie `black-translucent`: Damit legt iOS 26 seinen Liquid-Glass-Blur über das Foto und WebKit macht Home-Bildschirm-Apps eine Statusleiste zu kurz (Streifen unten, WebKit #313800). Die Fotofarbe am unteren Rand färbt nur noch den Seitenhintergrund. iOS übernimmt die Statusleisten-Einstellung nur beim Hinzufügen zum Home-Bildschirm: Icon löschen und neu hinzufügen.
- Kamera/Mikrofon (V1.05): Der iOS-Systemdialog lässt sich nicht abschalten. Die App fragt einmal früh (bei „Das bin ich“ bzw. beim ersten Tippen nach dem Start), stoppt die Spuren sofort und fragt nicht, wenn die Berechtigung schon erteilt ist. Dauerhaft still nur, wenn in den iOS-Einstellungen Kamera und Mikrofon auf „Erlauben“ stehen.
- Klingelton (V1.06): eingehende Anrufe spielen `sounds/ringtone.m4a` (eigener, synthetisch erzeugter Ton, `npm run generate-ringtone`), Web-Audio-Akkord als Fallback. Nach dem ersten Tippen läuft `sounds/keepalive.m4a` (praktisch stumm) in Schleife und hält die iOS-Audio-Sitzung offen, damit ein späterer Anruf ohne neues Tippen klingeln kann; während eines Gesprächs pausiert die Schleife. Grenzen: vor dem allerersten Tippen nach dem Start und bei iPad-Lautstärke null/stumm bleibt es still („Tippen zum Annehmen“).
- Begrüßung (V1.06): „Hallo …, wen willst du anrufen?“ oben rechts, rechtsbündig.
- Adressbuch und „Zum Foto“ (V1.06): beide unten rechts an derselben Stelle (nur Hanna). „Zurück zum Familienfoto“ bleibt unten links.
- Kein Pinch-Zoom (V1.06): auf dem iPad (jede Ausrichtung) lässt sich das Foto nicht per Pinch vergrößern, auch kein Seiten-Zoom. Tippen auf ein Gesicht zoomt weiter auf die Person. Auf iPhones hochkant (Empfänger) bleibt Pinch/Verschieben, damit alle Köpfe erreichbar sind.
