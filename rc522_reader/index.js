/**
 * RC522 Reader Add-on (Home Assistant)
 *
 * Aufgabe:
 * - RC522 (MFRC522) über SPI auslesen
 * - UID eines Tags erkennen
 * - Events per MQTT publishen:
 *     <topic_base>/present  { event:"present", uid:"...", ts:<ms since epoch> }
 *     <topic_base>/removed  { event:"removed", uid:"...", ts:<ms since epoch> }
 * - Zusätzlich ein "State"-Topic publishen:
 *     <topic_base>/state    { present:true/false, uid:"..."|null, ts:<ms> }
 *
 * Wichtige Idee:
 * - "present" wird nur beim Wechsel auf eine neue UID gesendet (kein Spam pro Poll).
 * - "removed" wird gesendet, wenn für eine gewisse Zeit kein Tag mehr erkannt wurde.
 */

const fs   = require("fs");
const mqtt = require("mqtt");
const { MFRC522 } = require("./lib/mfrc522");

// Home Assistant schreibt Add-on-Optionen aus der UI nach /data/options.json
const OPT_PATH = "/data/options.json";

// Optionen laden (MQTT Host/User/Pass, topic_base, SPI bus/device, poll_ms, removed_ms)
function loadOptions() {
  const raw = fs.readFileSync(OPT_PATH, "utf8");
  return JSON.parse(raw);
}

// Kleiner Helfer: wartet X Millisekunden
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {

  // 1) Konfiguration einlesen
  const o = loadOptions();

  // SPI-Pfad bestimmen: entweder aus spi_path direkt, oder aus spi_bus + spi_device
  const spiPath = String(o.spi_path || "").trim();
  let spiBus   = Number(o.spi_bus   ?? 0);
  let spiDevice = Number(o.spi_device ?? 0);

  if (spiPath) {
    const match = spiPath.match(/^\/dev\/spidev(\d+)\.(\d+)$/);
    if (!match) throw new Error(`Ungültiger spi_path: ${spiPath}`);
    spiBus   = Number(match[1]);
    spiDevice = Number(match[2]);
  }

  // topic_base ohne abschließende "/" normalisieren
  const topicBase = String(o.topic_base || "rfid/rc522").replace(/\/+$/, "");

  // 2) MQTT verbinden
  const url = `mqtt://${o.mqtt_host}:${Number(o.mqtt_port || 1883)}`;

  const client = mqtt.connect(url, {
    username: o.mqtt_username || undefined,
    password: o.mqtt_password || undefined,
  });

  client.on("connect",   () => console.log("MQTT connected:", url, "topic:", topicBase));
  client.on("error",     (e) => console.error("MQTT error:", e?.message || e));
  client.on("close",     () => console.warn("MQTT Verbindung getrennt — versuche Reconnect..."));
  client.on("reconnect", () => console.log("MQTT reconnecting..."));

  // 3) RC522 initialisieren
  // RST-Pin ist fest auf GPIO 25 verdrahtet
  // speedHz: 100 kHz — konservativ, funktioniert zuverlässig mit Clone-Modulen
  const r = new MFRC522({
    bus:      spiBus,
    device:   spiDevice,
    speedHz:  100_000,
  });

  r.open();
  try {
    await r.init();
  } catch (e) {
    console.error("FEHLER beim Start:", e.message);
    console.error("App wird beendet. Bitte Verkabelung prüfen und Addon neu starten.");
    process.exit(1);
  }
  console.log(`RC522 ready — SPI: /dev/spidev${spiBus}.${spiDevice}, RST: GPIO 25, Speed: ${r.speedHz / 1000} kHz`);

  // 4) Timing-Parameter
  const pollMs    = Math.max(50,  Number(o.poll_ms    ?? 200));  // wie oft nach Tag schauen
  const removedMs = Math.max(100, Number(o.removed_ms ?? 800)); // wann "removed" feuern

  // 5) Zustand merken, um nicht zu spammen
  let presentUid = null; // aktuell anliegende UID (string) oder null
  let lastSeen   = 0;    // Zeit (ms), wann zuletzt ein Tag erkannt wurde
  let errorCount = 0;
  
  // 6) Hauptloop: Endlos RFID abfragen
  while (true) {
    try {
      const now = Date.now();

      // requestA() = "Ist eine Karte im Feld?" → ATQA zurück oder null
      const atqa = await r.requestA();

      // --- Kein Tag im Feld ---
      if (!atqa) {
        // Wenn vorher ein Tag da war und lange genug weg ist → removed senden
        if (presentUid && now - lastSeen >= removedMs) {
          client.publish(`${topicBase}/removed`,
            JSON.stringify({ event: "removed", uid: presentUid, ts: now }));
          client.publish(`${topicBase}/state`,
            JSON.stringify({ present: false, uid: null, ts: now }));
          presentUid = null;
        }
        await sleep(pollMs);
        continue;
      }

      // --- Tag ist da: UID lesen ---
      const uid4 = await r.anticollCL1(); // 4 UID-Bytes oder null
      if (!uid4) {
        await sleep(pollMs);
        continue;
      }

      const uid = MFRC522.uidToHex(uid4); // z.B. "8aeda760"
      lastSeen = now;
      errorCount = 0; // ← neu

      // Nur bei UID-Wechsel publishen (kein Spam bei jedem Poll)
      if (uid !== presentUid) {
        presentUid = uid;
        client.publish(`${topicBase}/present`,
          JSON.stringify({ event: "present", uid, ts: now }));
        client.publish(`${topicBase}/state`,
          JSON.stringify({ present: true, uid, ts: now }));
        console.log("PRESENT", uid);
      }

    } catch (e) {
      console.error("RC522 loop:", e?.message || e);
      errorCount++;
      if (errorCount >= 10) {
        console.error("RC522 antwortet nicht mehr — erzwinge Neustart...");
        process.exit(1);
      }
      await sleep(500);
    }

    await sleep(pollMs);
  }

})();