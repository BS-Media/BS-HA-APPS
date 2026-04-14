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
 * - RC522 Watchdog: nach 10 aufeinanderfolgenden SPI-Fehlern → Neustart
 * - missCount: "removed" erst nach 8 aufeinanderfolgenden Polls ohne sicher lesbaren Tag —
 *              verhindert falsches "removed" bei kurzen Leseaussetzern
 */

const fs = require("fs");
const mqtt = require("mqtt");
const { MFRC522 } = require("./lib/mfrc522");

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

  const spiPath = String(o.spi_path || "").trim();
  let spiBus = Number(o.spi_bus ?? 0);
  let spiDevice = Number(o.spi_device ?? 0);

  if (spiPath) {
    const match = spiPath.match(/^\/dev\/spidev(\d+)\.(\d+)$/);
    if (!match) throw new Error(`Ungültiger spi_path: ${spiPath}`);
    spiBus = Number(match[1]);
    spiDevice = Number(match[2]);
  }

  const topicBase = String(o.topic_base || "rfid/rc522").replace(/\/+$/, "");
  const pollMs = Math.max(50, Number(o.poll_ms ?? 200));

  // Wie viele Polls ohne sicher lesbaren Tag bis "removed" gesendet wird
  // Beispiel: 8 Misses bei 200 ms ≈ 1,6 s
  const maxMissesBeforeRemoved = 8;

  // ── 2) Zustandsvariablen ─────────────────────────────────────────────────

  let presentUid = null; // UID des aktuell bekannten Tags oder null
  let errorCount = 0;    // aufeinanderfolgende SPI-/Reader-Fehler → Watchdog
  let missCount = 0;     // aufeinanderfolgende Polls ohne sicher lesbaren Tag

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
    speedHz: 100_000, // konservativ und stabil mit Clone-Modulen
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

      // Fragt den RC522: "Ist irgendetwas im Feld?"
      const atqa = await r.requestA();

      // requestA() hat geantwortet → der Reader lebt grundsätzlich
      errorCount = 0;

      // Kein Tag im Feld
      if (!atqa) {
        missCount++;

        if (presentUid && missCount >= maxMissesBeforeRemoved) {
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

      // Irgendetwas ist im Feld → UID lesen
      const uid4 = await r.anticollCL1();

      // Tag vermutlich im Feld, UID aber gerade nicht stabil lesbar.
      // Noch kein Miss zählen, damit wir nicht fälschlich auf "frei" gehen.
      if (!uid4) {
        await sleep(pollMs);
        continue;
      }

      // Vollständige erfolgreiche UID-Lesung
      const uid = MFRC522.uidToHex(uid4);

      missCount = 0;

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

      // Nach mehreren echten Reader-/SPI-Fehlern Neustart erzwingen
      if (errorCount >= 10) {
        console.error("RC522 antwortet nicht mehr — erzwinge Neustart...");
        process.exit(1);
      }

      await sleep(500);
    }

    await sleep(pollMs);
  }
})();