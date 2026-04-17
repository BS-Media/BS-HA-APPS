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
 *
 * Kein halt(), kein antennaReset() im Normalpfad.
 * Recovery nur gezielt bei echter Blindphase oder Reader-/SPI-Fehlern.
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

// Diagnose: sichtbar machen, falls der Prozess extern beendet oder intern crasht
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err?.stack || err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err?.stack || err);
});

process.on("exit", (code) => {
  console.error("PROCESS EXIT with code:", code);
});

process.on("SIGTERM", () => {
  console.error("PROCESS GOT SIGTERM");
});

process.on("SIGINT", () => {
  console.error("PROCESS GOT SIGINT");
});

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
  const pollMs = Math.max(50, Number(o.poll_ms ?? 200));
  const removedMs = Math.max(100, Number(o.removed_ms ?? 800));
  const debugMode = Boolean(o.debug ?? false);

  const maxMissesBeforeRemoved = Math.max(2, Math.ceil(removedMs / pollMs));
  const maxUidFailsBeforeReInit = 8;
  const maxErrorsBeforeRestart = 10;
  const statsLogInterval = 500;
  const heartbeatInterval = 50;
  const idleRecoveryMissThreshold = Math.max(25, Math.ceil(5000 / pollMs));

  let presentUid = null;
  let missCount = 0;
  let uidFailCount = 0;
  let errorCount = 0;
  let pollCount = 0;
  let idleRecoveryDone = false;

  function dbg(...args) {
    if (debugMode) console.log("[MAIN:DBG]", ...args);
  }

  async function publishRemoved(now, reason) {
    if (!presentUid) return;

    client.publish(
      `${topicBase}/removed`,
      JSON.stringify({ event: "removed", uid: presentUid, ts: now, reason })
    );
    client.publish(
      `${topicBase}/state`,
      JSON.stringify({ present: false, uid: null, ts: now }),
      { retain: true }
    );
    console.log("REMOVED", presentUid, `reason=${reason}`);

    presentUid = null;
    missCount = 0;
    idleRecoveryDone = false;
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

  console.log("MAIN LOOP START");

  while (true) {
    try {
      const now = Date.now();
      pollCount++;
      if (r._stats) r._stats.polls = pollCount;

      if ((pollCount % heartbeatInterval) === 0) {
        console.log(
          `HEARTBEAT poll=${pollCount} presentUid=${presentUid} ` +
          `missCount=${missCount} uidFailCount=${uidFailCount} errorCount=${errorCount}`
        );
      }

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
          await publishRemoved(now, "no-atqa");
        }

        if (!presentUid && !idleRecoveryDone && missCount >= idleRecoveryMissThreshold) {
          idleRecoveryDone = true;
          console.warn(
            `RC522: ${missCount} Misses ohne Tag → gezielte Idle-Recovery`
          );
          try {
            await r.softReset();
            await r.init();
            missCount = 0;
            console.log("RC522: Idle-Recovery erfolgreich");
          } catch (e) {
            console.error("RC522: Idle-Recovery fehlgeschlagen:", e?.message);