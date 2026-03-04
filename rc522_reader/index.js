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

/**
 * Imports (Node.js):
 * - fs: Dateisystem (wir lesen /data/options.json)
 * - mqtt: MQTT-Client (publish/subscribe)
 * - MFRC522: Treiberlogik für den RC522 (spricht intern über spi-device mit /dev/spidevX.Y)
 */
const fs = require("fs");
const mqtt = require("mqtt");
const { MFRC522 } = require("./lib/mfrc522");

// Home Assistant schreibt Add-on-Optionen aus der UI nach /data/options.json
const OPT_PATH = "/data/options.json";

/** Optionen laden (MQTT Host/User/Pass, topic_base, SPI bus/device, poll_ms, removed_ms, ...) */
function loadOptions() {
  const raw = fs.readFileSync(OPT_PATH, "utf8");
  return JSON.parse(raw);
}

/** Sleep-Helper für async/await */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  // 1) Konfiguration einlesen
  const o = loadOptions();

  // topic_base ohne abschließende "/" normalisieren (damit Topics sauber sind)
  const topicBase = String(o.topic_base || "rfid/rc522").replace(/\/+$/, "");

  // 2) MQTT verbinden
  // Beispiel: mqtt://core-mosquitto:1883
  const url = `mqtt://${o.mqtt_host}:${Number(o.mqtt_port || 1883)}`;

  const client = mqtt.connect(url, {
    // Wenn leer, undefined übergeben -> mqtt lib lässt es weg
    username: o.mqtt_username || undefined,
    password: o.mqtt_password || undefined,
  });

  client.on("connect", () => {
    console.log("MQTT connected:", url, "topic:", topicBase);
  });

  client.on("error", (e) => {
    console.error("MQTT error:", e?.message || e);
  });

  // 3) RC522 initialisieren
  // bus/device -> /dev/spidev<bus>.<device>
  // bus=0, device=0 => /dev/spidev0.0 (CE0)
  const r = new MFRC522({
    bus: Number(o.spi_bus ?? 0),
    device: Number(o.spi_device ?? 0),
    speedHz: 1_000_000, // 1 MHz: konservativ/stabil
  });

  r.open();       // SPI device öffnen
  await r.init(); // RC522 Register/Timer/Modus setzen + Antenne an
  console.log("RC522 ready on SPI", o.spi_bus, "device", o.spi_device);

  // 4) Timing-Parameter (mit unteren Grenzen, damit man sich nicht totkonfiguriert)
  const pollMs = Math.max(50, Number(o.poll_ms ?? 200));        // wie oft nach Tag schauen
  const removedMs = Math.max(100, Number(o.removed_ms ?? 800)); // wann "removed" feuern

  // 5) Zustand merken, um nicht zu spammen
  let presentUid = null; // aktuell "anliegende" UID (string) oder null
  let lastSeen = 0;      // Zeit (ms), wann zuletzt ein Tag erkannt wurde

  // 6) Hauptloop: Endlos RFID abfragen
  while (true) {
    try {
      const now = Date.now();

      // requestA() = "ist ein Tag da?" -> ATQA zurück oder null
      const atqa = await r.requestA();

      // --- Kein Tag im Feld ---
      if (!atqa) {
        // Wenn vorher ein Tag da war und lange genug weg ist -> removed senden
        if (presentUid && now - lastSeen >= removedMs) {
          // Event: Tag wurde entfernt
          client.publish(
            `${topicBase}/removed`,
            JSON.stringify({ event: "removed", uid: presentUid, ts: now })
          );

          // State: aktuell kein Tag präsent (UID wird geleert)
          client.publish(
            `${topicBase}/state`,
            JSON.stringify({ present: false, uid: null, ts: now })
          );

          presentUid = null;
        }

        await sleep(pollMs);
        continue; // nächsten Poll
      }

      // --- Tag ist da: UID lesen (Anticollision CL1) ---
      const uid4 = await r.anticollCL1(); // liefert 4 UID-Bytes oder null
      if (!uid4) {
        await sleep(pollMs);
        continue;
      }

      // UID in Hex-String wandeln (z.B. "8aeda760")
      const uid = MFRC522.uidToHex(uid4);

      // Tag wurde gesehen -> lastSeen aktualisieren
      lastSeen = now;

      // Nur bei UID-Wechsel publishen (sonst Spam bei jedem Poll)
      if (uid !== presentUid) {
        presentUid = uid;

        // Event: neuer Tag erkannt
        client.publish(
          `${topicBase}/present`,
          JSON.stringify({ event: "present", uid, ts: now })
        );

        // State: Tag ist aktuell präsent + welche UID
        client.publish(
          `${topicBase}/state`,
          JSON.stringify({ present: true, uid, ts: now })
        );

        console.log("PRESENT", uid);
      }
    } catch (e) {
      // Robustheit: Fehler loggen, kurz warten, dann weiter
      console.error("RC522 loop:", e?.message || e);
      await sleep(500);
    }

    // Poll-Rate begrenzen
    await sleep(pollMs);
  }
})();