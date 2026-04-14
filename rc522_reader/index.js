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
 * - missCount: "removed" erst nach mehreren Polls ohne Tag
 * - uidFailCount: wenn ein Tag erkannt wird, aber die UID mehrfach hintereinander
 *   nicht lesbar ist, wird ein Neustart erzwungen
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

  const maxMissesBeforeRemoved = 8;
  const maxUidFailsBeforeRestart = 8;
  const maxErrorsBeforeRestart = 10;

  // ── 2) Zustandsvariablen ─────────────────────────────────────────────────

  let presentUid = null;   // aktuell bekannter Tag oder null
  let missCount = 0;       // Polls ohne Tag im Feld
  let uidFailCount = 0;    // Tag im Feld, aber UID nicht lesbar
  let errorCount = 0;      // echte SPI-/Reader-Fehler

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

      // Reader fragt: ist überhaupt etwas im Feld?
      const atqa = await r.requestA();

      // requestA hat geantwortet → SPI/Reader lebt grundsätzlich
      errorCount = 0;

      // Kein Tag im Feld
      if (!atqa) {
        uidFailCount = 0;
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
          missCount = 0;
        }

        await sleep(pollMs);
        continue;
      }

      // Es ist etwas im Feld → nicht als "kein Tag" zählen
      missCount = 0;

      // UID lesen
      const uid4 = await r.anticollCL1();

      // Es ist etwas im Feld, aber UID nicht lesbar → problematischer Zwischenzustand
      if (!uid4) {
        uidFailCount++;

        console.warn(
          `RC522 UID-Lesung fehlgeschlagen ${uidFailCount}/${maxUidFailsBeforeRestart} auf /dev/spidev${spiBus}.${spiDevice}`
        );

        if (uidFailCount >= maxUidFailsBeforeRestart) {
          console.error("RC522 hängt in der UID-Lesung — erzwinge Neustart...");
          process.exit(1);
        }

        await sleep(pollMs);
        continue;
      }

      // Erfolgreiche UID-Lesung
      uidFailCount = 0;

      const uid = MFRC522.uidToHex(uid4);

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
        `RC522 loop Fehler ${errorCount}/${maxErrorsBeforeRestart} auf /dev/spidev${spiBus}.${spiDevice}:`,
        e?.message || e
      );

      if (errorCount >= maxErrorsBeforeRestart) {
        console.error("RC522 antwortet nicht mehr — erzwinge Neustart...");
        process.exit(1);
      }

      await sleep(500);
    }

    await sleep(pollMs);
  }
})();