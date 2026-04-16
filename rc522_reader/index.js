/**
 * RC522 Reader Add-on (Home Assistant)
 *
 * ÄNDERUNGEN gegenüber v0.3.5:
 * - haltA() nach jedem erfolgreichen UID-Lesen → Karte wird deselektiert
 * - antennaReset() bei "removed" → RF-Feld wird neu aufgebaut
 * - Periodischer antennaReset alle N Polls → verhindert "taubes" Feld bei langem Kabel
 * - requestA/anticollCL1 Fehler werden abgefangen statt den Loop zu crashen
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

  // NEU: Alle 200 Polls ohne Karte → Antenne kurz resetten
  const antennaResetInterval = 200;

  // ── 2) Zustandsvariablen ─────────────────────────────────────────────────

  let presentUid = null;
  let missCount = 0;
  let uidFailCount = 0;
  let errorCount = 0;
  let pollsSinceAntennaReset = 0; // NEU

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

      // NEU: Periodischer Antenna-Reset wenn lange keine Karte da war
      // Nur wenn der Chip auch wirklich antwortet (ModeReg-Check)
      pollsSinceAntennaReset++;
      if (!presentUid && pollsSinceAntennaReset >= antennaResetInterval) {
        try {
          const check = await r.readReg(0x11); // ModeReg
          if (check !== 0x00 && check !== 0xFF) {
            await r.antennaReset();
          }
        } catch {}
        pollsSinceAntennaReset = 0;
      }

      // Reader fragt: ist überhaupt etwas im Feld?
      // Benutzt jetzt WUPA statt REQA → weckt auch gehaltete Karten
      const atqa = await r.requestA();

      // requestA hat geantwortet → SPI/Reader lebt
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

          console.log("REMOVED", presentUid);
          presentUid = null;
          missCount = 0;

          // NEU: Nach "removed" Antenne resetten → sauberer Neustart des RF-Feldes
          await r.antennaReset();
          pollsSinceAntennaReset = 0;
        }

        await sleep(pollMs);
        continue;
      }

      // Es ist etwas im Feld
      missCount = 0;
      pollsSinceAntennaReset = 0;

      // UID lesen
      const uid4 = await r.anticollCL1();

      if (!uid4) {
        uidFailCount++;

        console.warn(
          `RC522 UID-Lesung fehlgeschlagen ${uidFailCount}/${maxUidFailsBeforeRestart} auf /dev/spidev${spiBus}.${spiDevice}`
        );

        if (uidFailCount >= maxUidFailsBeforeRestart) {
          console.error("RC522 hängt in der UID-Lesung — erzwinge Neustart...");
          process.exit(1);
        }

        // NEU: haltA versuchen, damit die Karte in einen definierten Zustand geht
        await r.haltA();
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

      // ── NEU: Karte nach dem Lesen in HALT versetzen ──
      // Das ist DER zentrale Fix: Ohne haltA bleibt die Karte im ACTIVE-Zustand.
      // Eine ACTIVE Karte ignoriert REQA/WUPA und wird beim nächsten Poll nicht erkannt.
      // Mit haltA → Karte geht in HALT → nächstes WUPA weckt sie wieder auf.
      await r.haltA();

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

      // Bei wiederholten Fehlern: vollen Soft-Reset + Re-Init versuchen
      if (errorCount >= 3) {
        try {
          console.log("RC522: Versuche Soft-Reset + Re-Init...");
          await r.softReset();
          await r.init();
          console.log("RC522: Re-Init erfolgreich");
          errorCount = 0; // Reset hat geklappt, Zähler zurück
        } catch (reinitErr) {
          console.error("RC522: Re-Init fehlgeschlagen:", reinitErr?.message);
        }
      }

      await sleep(500);
    }

    await sleep(pollMs);
  }
})();