/**
 * RC522 Reader Add-on (Home Assistant)
 *
 * Liest RC522/MFRC522 per SPI und publiziert Events per MQTT.
 * Basierend auf pi-rc522 (ondryaso) — portiert nach Node.js.
 * Kein IRQ nötig — reiner Polling-Modus.
 *
 * Ablauf pro Poll:
 *   1. request(WUPA) → ist eine Karte da?
 *   2. readId()      → UID lesen (CL1, bei Cascade auch CL2)
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
  const pollMs = Math.max(50, Number(o.poll_ms ?? 300));
  const removedMs = Math.max(100, Number(o.removed_ms ?? 1200));
  const debugMode = Boolean(o.debug ?? true);

  const maxMissesBeforeRemoved = Math.max(2, Math.ceil(removedMs / pollMs));
  const maxUidFailsBeforeReInit = 8;
  const maxErrorsBeforeRestart = 10;
  const statsLogInterval = 500;

  let presentUid = null;
  let missCount = 0;
  let uidFailCount = 0;
  let errorCount = 0;
  let pollCount = 0;

  function dbg(...args) {
    if (debugMode) console.log("[MAIN:DBG]", ...args);
  }

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
      }),
      { retain: true }
    );
  });

  client.on("error", (e) => console.error("MQTT error:", e?.message || e));
  client.on("close", () => console.warn("MQTT Verbindung getrennt — Reconnect..."));
  client.on("reconnect", () => console.log("MQTT reconnecting..."));

  const r = new MFRC522({
    bus: spiBus,
    device: spiDevice,
    speedHz: 100_000,
    antennaGain: 0x04,
    debug: debugMode,
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
    `RC522 ready — SPI: /dev/spidev${spiBus}.${spiDevice}, RST: GPIO 25, ` +
    `Speed: ${r.speedHz / 1000} kHz, Gain: ${r.antennaGain}, ` +
    `Debug: ${debugMode}, Poll: ${pollMs}ms, ` +
    `Removed: ${removedMs}ms (${maxMissesBeforeRemoved} misses)`
  );

  while (true) {
    try {
      const now = Date.now();
      pollCount++;
      if (r._stats) r._stats.polls = pollCount;

      if (debugMode && (pollCount % statsLogInterval) === 0) {
        console.log(`[STATS] ${r.statsLine()}`);
        await r.dumpState("periodic");
      }

      const atqa = await r.request(0x52); // WUPA
      errorCount = 0;

      if (!atqa) {
        uidFailCount = 0;
        missCount++;
        dbg("no atqa", { missCount, presentUid });

        if (presentUid && missCount >= maxMissesBeforeRemoved) {
          client.publish(
            `${topicBase}/removed`,
            JSON.stringify({ event: "removed", uid: presentUid, ts: now })
          );
          client.publish(
            `${topicBase}/state`,
            JSON.stringify({ present: false, uid: null, ts: now }),
            { retain: true }
          );
          console.log("REMOVED", presentUid);
          presentUid = null;
          missCount = 0;

          // Nur kurze Ruhezeit, kein halt(), kein antennaReset()
          await sleep(300);
        }

        await sleep(pollMs);
        continue;
      }

      dbg("atqa ok", atqa);

      missCount = 0;

      const idResult = await r.readId();

      if (!idResult) {
        uidFailCount++;
        dbg("atqa ok, readId failed", { uidFailCount });

        if (uidFailCount >= maxUidFailsBeforeReInit) {
          console.warn(
            `RC522: ${maxUidFailsBeforeReInit}x UID-Lesung fehlgeschlagen → Re-Init`
          );
          try {
            await r.softReset();
            await r.init();
            console.log("RC522: Re-Init nach UID-Fehler erfolgreich");
          } catch (e) {
            console.error("RC522: Re-Init fehlgeschlagen:", e?.message);
          }
          uidFailCount = 0;
        }

        await sleep(pollMs);
        continue;
      }

      uidFailCount = 0;

      const uid = idResult.uidHex;
      dbg("readId ok", { uid });

      if (uid !== presentUid) {
        presentUid = uid;

        client.publish(
          `${topicBase}/present`,
          JSON.stringify({ event: "present", uid, ts: now })
        );
        client.publish(
          `${topicBase}/state`,
          JSON.stringify({ present: true, uid, ts: now }),
          { retain: true }
        );
        console.log("PRESENT", uid);
      }

      // bewusst kein halt()
      // bewusst kein antennaReset() im Normalpfad

    } catch (e) {
      errorCount++;

      console.error(
        `RC522 loop Fehler ${errorCount}/${maxErrorsBeforeRestart} auf ` +
        `/dev/spidev${spiBus}.${spiDevice}: ${e?.message || e}`
      );

      if (debugMode) {
        await r.dumpState("error");
      }

      if (errorCount >= maxErrorsBeforeRestart) {
        console.error("RC522 antwortet nicht mehr — erzwinge Neustart...");
        console.log(`[STATS:FINAL] ${r.statsLine()}`);
        process.exit(1);
      }

      if (errorCount >= 3) {
        try {
          console.log("RC522: Versuche Soft-Reset + Re-Init...");
          await r.softReset();
          await r.init();
          console.log("RC522: Re-Init erfolgreich");
          errorCount = 0;
        } catch (reinitErr) {
          console.error("RC522: Re-Init fehlgeschlagen:", reinitErr?.message);
        }
      }

      await sleep(500);
    }

    await sleep(pollMs);
  }
})();