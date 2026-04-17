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
          }
        }

        await sleep(pollMs);
        continue;
      }

      dbg("atqa ok", atqa);
      idleRecoveryDone = false;

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
      missCount = 0;
      idleRecoveryDone = false;

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

    } catch (e) {
      errorCount++;

      console.error(
        `RC522 loop Fehler ${errorCount}/${maxErrorsBeforeRestart} auf ` +
        `/dev/spidev${spiBus}.${spiDevice}: ${e?.stack || e?.message || e}`
      );

      if (debugMode) {
        await r.dumpState("error");
      }

      if (errorCount >= maxErrorsBeforeRestart) {
        console.error("RC522 antwortet nicht mehr — erzwinge Neustart...");
        if (r._stats) console.log(`[STATS:FINAL] ${r.statsLine()}`);
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