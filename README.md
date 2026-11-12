# Hannafon

Lokale PWA für Familien-Videoanrufe (V1.09). Vanilla HTML, CSS und JavaScript.

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

- Service-Worker-Cache: `hannafon-v1.09`
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
- iOS-Statusleiste (V1.07): iOS 26+ ignoriert `theme-color` und die Statusleisten-Meta und nimmt die Farbe der Seite (html/body und fest positionierte Elemente oben). Deshalb sind html, body und `#app` jetzt schwarz (Creme nur noch auf den Bildschirmen darin), in der Home-Bildschirm-App liegt ganz oben ein schwarzer fester Streifen `#statusbar-fill` (mind. 6 px hoch, volle Breite, nur `html.is-standalone`). Dazu `theme-color` schwarz auch für hell/dunkel und Manifest `background_color` `#000000` (schwarzer Startbildschirm). Weiterhin `black`, nie `black-translucent`. Icon löschen und neu hinzufügen, damit iOS Meta und Manifest neu einliest.
- Kamerabild (V1.08): immer das ganze Kamerabild, nie beschnitten. Anfrage 4:3 (1280×960 ideal, natives Format der Frontkameras, iOS dreht hochkant selbst), statt 16:9, das iOS oben/unten beschnitt. Gegenüber und eigenes Bild mit `object-fit: contain` in echtem Seitenverhältnis (hochkant bleibt hochkant), schwarze Ränder. Das eigene Bild (rechts oben) übernimmt die Form des Kamerabilds (`--local-ar`).
- Display-Rundung (V1.07/V1.08): nur oben, nur iPad/iPad mini (`html.is-tablet`). Seit V1.08 beginnt der ganze Viertelkreis bündig unter der schwarzen Statusleiste: `#app` wird mit `clip-path: inset(var(--bar-h) 0 0 0 round R R 0 0)` beschnitten, `R = clamp(18px, 2.7vmin, 26px)`; `--bar-h` ist die Höhe des schwarzen Streifens `#statusbar-fill` (in der installierten App `max(6px, safe-area-inset-top)`, im Browser-Tab 0). Der Streifen bleibt ein eckiges, schwarzes Rechteck; `body` wird nicht mehr beschnitten. Unten eckig, iPhone ohne Rundung.
- Verpasste Anrufe (V1.08, nur Hanna): unten links erscheint „Verpasste Anrufe“ (Creme-Pille, orangefarbenes Telefon-Icon, orangefarbene Zahl = Anzahl Personen) nur, wenn Anrufe verpasst wurden. Die Liste sieht aus wie das Adressbuch (Gesicht, Name, Zeit „gerade eben“ / „vor 5 Minuten“ / „heute 14:30“, bei mehreren „2 Anrufe · …“, Anrufen-Knopf). Wer „Zum Foto“ oder „Anrufen“ tippt, verlässt die Liste: alle Einträge gelten als gesehen, werden auch im Worker gelöscht, der Knopf verschwindet. Verpasst = es klingelte bei Hanna und niemand nahm an (Anrufer legt auf, Anrufer-Gerät weg, Klingeln nach 5 Minuten abgelaufen); nicht bei Annehmen oder wenn Hanna ablehnt. Der Worker speichert nur Gesichtsnummern, Anzahl und Zeitstempel (Tabelle `missed_calls`, 14 Tage), schickt die Liste beim Verbinden (`hello`) und bei Änderungen; lokal zusätzlich `localStorage`.
- Begrüßung (V1.06): „Hallo …, wen willst du anrufen?“ oben rechts, rechtsbündig.
- Adressbuch und „Zum Foto“ (V1.06): beide unten rechts an derselben Stelle (nur Hanna). „Zurück zum Familienfoto“ bleibt unten links.
- Kein Pinch-Zoom (V1.06): auf dem iPad (jede Ausrichtung) lässt sich das Foto nicht per Pinch vergrößern, auch kein Seiten-Zoom. Tippen auf ein Gesicht zoomt weiter auf die Person. Auf iPhones hochkant (Empfänger) bleibt Pinch/Verschieben, damit alle Köpfe erreichbar sind.
- Gruppenanrufe (V1.09, nur Hanna, vom Foto aus): Im Zoom steht neben „Anrufen“ die Creme-Pille „Noch jemanden dazu“. Danach oben rechts „Wen noch? Tippe auf alle, die mit dabei sein sollen.“; Tippen auf Gesichter wählt/abwählt (grüner Ring mit Haken), höchstens drei weitere Personen (sonst kurzer Hinweis), Hanna selbst und Nr. 7/12 nicht wählbar, mindestens eine Person bleibt gewählt. Unten in der Mitte eine grüne Pille „Maria und Daniel anrufen“ / „Maria, Daniel und Anna anrufen“; „Zum Foto“ bricht ab. Das Adressbuch bleibt in V1.09 bei Einzelanrufen.
- Gruppenanruf, Ablauf: Jede eingeladene Person bekommt einen normalen Anruf von Hanna (Push, Wiederholung beim Öffnen, „Anderswo angenommen“ pro Person, verpasste Anrufe wie bisher). Beim Empfänger: Creme + App-Icon, „Hanna ruft an“ und darunter „mit Maria“ / „mit Maria und Daniel“. Im Gespräch: Kacheln (ganzes Bild, `contain`, schwarze Ränder, Vorname), wer noch nicht abgenommen hat, erscheint als Creme-Kachel mit Buchstabe und „klingelt…“. Ablehnen oder 60 s ohne Antwort: Kachel verschwindet, der Rest spricht weiter (ohne Antwort = verpasster Anruf, Ablehnen nicht). Hannas „Auflegen“ beendet für alle, ein Gast verlässt nur selbst.
- Gruppenanruf, Technik: Mesh ohne Server-Medien, nur STUN (kein TURN). Hanna ↔ Gast über die normalen `call`/`answer`/`ice`; nimmt jemand an, schickt Hanna allen schon Verbundenen `peer-join`, und der schon verbundene Gast bietet dem Neuen an (`peer-offer`/`peer-answer`/`peer-ice`, keine Kollision). Hanna verteilt die Teilnehmerliste (`group-state`), ein Gast verlässt mit `hangup` an Hanna + `peer-leave` an die anderen. Der Worker leitet diese Nachrichten nur weiter (keine Speicherung) und meldet `declined`, wenn alle verbundenen Geräte einer Person abgelehnt haben.
- Datenvolumen (V1.09): jedes Gerät begrenzt, was es sendet (`RTCRtpSender.setParameters`): Einzelanruf Video 1000 kbit/s, 24 fps, Audio 48 kbit/s → etwa 1,0 GB pro Stunde auf Hannas iPad (senden + empfangen). Gruppe mit 2 anderen: 600 kbit/s pro Strom (2 raus, 2 rein) → etwa 1,2 GB/h; mit 3 anderen: 450 kbit/s pro Strom → etwa 1,4 GB/h. Aufnahme bleibt 4:3 1280×960, nie beschnitten. Keine Einstellungsseite.
