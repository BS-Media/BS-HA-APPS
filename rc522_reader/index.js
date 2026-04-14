/**
 * RC522 Reader Add-on (Home Assistant)
 *
 * Was macht diese App:
 * - Liest den RC522 RFID-Chip über SPI aus
 * - Erkennt RFID-Tags (Karten/Schlüsselanhänger) und liest ihre UID
 * - Publiziert Events per MQTT:
 *     <topic_base>/present  → wenn ein neuer Tag erkannt wird
 *     <topic_base>/removed  → wenn ein Tag entfernt wurde
 *     <topic_base>/state    → aktueller Zustand (immer aktuell, auch nach Reconnect)
 *
 * Robustheit:
 * - MQTT: reconnectet automatisch, publiziert nach Reconnect den aktuellen State neu
 * - RC522: Watchdog — wenn der Chip 10x hintereinander nicht antwortet → Neustart
 *           HA startet die App danach automatisch wieder
 */

const fs   = require("fs");
const mqtt = require("mqtt");
const { MFRC522 } = require("./lib/mfrc522");

// Home Assistant schreibt die Add-on-Optionen aus der UI hierhin
const OPT_PATH = "/data/options.json";

function loadOptions() {
  const raw = fs.readFileSync(OPT_PATH, "utf8");
  return JSON.parse(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  // ── 1) Konfiguration laden ───────────────────────────────────────────────

  const o = loadOptions();

  // SPI-Pfad: entweder direkt als "/dev/spidevX.Y" oder aus spi_bus + spi_device
  const spiPath = String(o.spi_path || "").trim();
  let spiBus = Number(o.spi_bus ?? 0);
  let spiDevice = Number(o.spi_device ?? 0);

  if (spiPath) {
    const match = spiPath.match(/^\/dev\/spidev(\d+)\.(\d+)$/);
    if (!match) throw new Error(`Ungültiger spi_path: ${spiPath}`);
    spiBus = Number(match[1]);
    spiDevice = Number(match[2]);
  }

  // topic_base ohne abschließenden "/"
  const topicBase = String(o.topic_base || "rfid/rc522").replace(/\/+$/, "");

  // Polling-Intervall und "removed"-Verzögerung mit Mindestwerten absichern
  const pollMs = Math.max(50, Number(o.poll_ms ?? 200));
  const removedMs = Math.max(100, Number(o.removed_ms ?? 800));

  // ── 2) Zustandsvariablen ─────────────────────────────────────────────────

  let presentUid = null; // UID des aktuell erkannten Tags, oder null
  let lastSeen = 0;      // Zeitstempel der letzten erfolgreichen Tag-Erkennung
  let errorCount = 0;    // aufeinanderfolgende RC522-Fehler für den Watchdog

  // ── 3) MQTT verbinden ────────────────────────────────────────────────────

  const url = `mqtt://${o.mqtt_host}:${Number(o.mqtt_port || 1883)}`;

  const client = mqtt.connect(url, {
    username: o.mqtt_username || undefined,
    password: o.mqtt_password || undefined,
  });

  client.on("connect", () => {
    console.log("MQTT connected:", url, "topic:", topicBase);
    client.publish(
      `${topicBase}/state`,
      JSON.stringify({
        present: presentUid !== null,
        uid: presentUid,
        ts: Date.now(),
      })
    );
  });

  client.on("error", (e) => {
    console.error("MQTT error:", e?.message || e);
  });

  client.on("close", () => {
    console.warn("MQTT Verbindung getrennt — versuche Reconnect...");
  });

  client.on("reconnect", () => {
    console.log("MQTT reconnecting...");
  });

  // ── 4) RC522 initialisieren ──────────────────────────────────────────────

  const r = new MFRC522({
    bus: spiBus,
    device: spiDevice,
    speedHz: 100_000,
  });

  r.open();

  try {
    await r.init();
  } catch (e) {
    console.error("FEHLER beim Start:", e.message);
    console.error("App wird beendet. Bitte Verkabelung prüfen und Addon neu starten.");
    process.exit(1);
  }

  console.log(
    `RC522 ready — SPI: /dev/spidev${spiBus}.${spiDevice}, RST: GPIO 25, Speed: ${r.speedHz / 1000} kHz`
  );

  // ── 5) Hauptloop ─────────────────────────────────────────────────────────

  while (true) {
    try {
      const now = Date.now();

      // Fragt den RC522: "Ist ein Tag im Feld?"
      const atqa = await r.requestA();

      // Wichtiger Punkt:
      // Sobald requestA() erfolgreich zurückkommt, lebt der Chip noch.
      // Deshalb hier bereits den Watchdog zurücksetzen.
      errorCount = 0;

      // Kein Tag im Feld
      if (!atqa) {
        if (presentUid && now - lastSeen >= removedMs) {
          client.publish(
            `${topicBase}/removed`,
            JSON.stringify({ event: "removed", uid: presentUid, ts: now })
          );

          client.publish(
            `${topicBase}/state`,
            JSON.stringify({ present: false, uid: null, ts: now })
          );

          presentUid = null;
        }

        await sleep(pollMs);
        continue;
      }

      // Tag ist da → UID lesen
      const uid4 = await r.anticollCL1();
      if (!uid4) {
        await sleep(pollMs);
        continue;
      }

      const uid = MFRC522.uidToHex(uid4);
      lastSeen = now;

      // Nur bei UID-Wechsel publishen
      if (uid !== presentUid) {
        presentUid = uid;

        client.publish(
          `${topicBase}/present`,
          JSON.stringify({ event: "present", uid, ts: now })
        );

        client.publish(
          `${topicBase}/state`,
          JSON.stringify({ present: true, uid, ts: now })
        );

        console.log("PRESENT", uid);
      }
    } catch (e) {
      errorCount++;
      console.error(
        `RC522 loop Fehler ${errorCount}/10 auf /dev/spidev${spiBus}.${spiDevice}:`,
        e?.message || e
      );

      if (errorCount >= 10) {
        console.error("RC522 antwortet nicht mehr — erzwinge Neustart...");
        process.exit(1);
      }

      await sleep(500);
    }

    await sleep(pollMs);
  }
})();