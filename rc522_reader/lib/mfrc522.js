          `${(errReg & 0x02) ? "Parity " : ""}` +
          `${(errReg & 0x08) ? "Collision " : ""}` +
          `${(errReg & 0x10) ? "BufferOvfl " : ""}` +
          `), tx=[${hexArr(data)}]`
        );
      }
    }

    this._dbg(
      `cardWrite: cmd=${hex(command)} tx=[${hexArr(data)}] → ` +
      `err=${error} bits=${backBits} rx=[${hexArr(backData)}] loops=${2000 - i}`
    );

    return { error, backData, backBits, errReg };
  }

  // ── PICC Operationen ──

  // request() — fragt ob eine Karte im Feld ist
  async request(reqMode = PICC_REQA) {
    this._stats.requests++;
    await this.writeReg(BitFramingReg, 0x07);
    const { error, backData, backBits } = await this.cardWrite(PCD_TRANSCEIVE, [reqMode]);

    if (error || backBits !== 0x10) {
      this._stats.requestFail++;
      return null;
    }
    this._stats.requestOk++;
    this._dbg(`request: ATQA=[${hexArr(backData)}]`);
    return backData;
  }

  // anticoll() — liest UID (4 Bytes + BCC)
  async anticoll(selCode = PICC_SEL_CL1) {
    this._stats.anticolls++;
    await this.writeReg(BitFramingReg, 0x00);
    const { error, backData } = await this.cardWrite(PCD_TRANSCEIVE, [selCode, PICC_ANTICOLL]);

    if (error || backData.length !== 5) {
      this._stats.anticollFail++;
      this._dbg(`anticoll(${hex(selCode)}): fehlgeschlagen, error=${error}, len=${backData.length}`);
      return null;
    }

    let check = 0;
    for (let i = 0; i < 4; i++) check ^= backData[i];
    if (check !== backData[4]) {
      this._stats.anticollFail++;
      this._dbg(`anticoll(${hex(selCode)}): BCC falsch`);
      return null;
    }

    this._stats.anticollOk++;
    this._dbg(`anticoll(${hex(selCode)}): uid=[${hexArr(backData)}]`);
    return backData;
  }

  // selectTag() — selektiert eine Karte (READY → ACTIVE)
  // Wird im Normalpfad NICHT aufgerufen, nur bei Cascade (7-Byte-UID)
  // oder wenn man danach Mifare-Blöcke lesen/schreiben will.
  async selectTag(uid5, selCode = PICC_SEL_CL1) {
    const buf = [selCode, PICC_SELECT];
    for (let i = 0; i < 5; i++) buf.push(uid5[i]);
    const crc = await this.calcCrc(buf);
    buf.push(crc[0], crc[1]);

    const { error, backData, backBits } = await this.cardWrite(PCD_TRANSCEIVE, buf);
    const ok = !error && backBits === 0x18;
    const sak = ok ? backData[0] : null;
    this._dbg(`selectTag(${hex(selCode)}): ok=${ok} sak=${sak !== null ? hex(sak) : "null"}`);
    return { ok, sak };
  }

  // readId() — liest die UID (4 oder 7 Bytes)
  // Für 4-Byte-UIDs: nur anticoll, kein selectTag.
  // Karte bleibt in READY — WUPA beim nächsten Poll spricht sie dort an.
  // Für 7-Byte-UIDs: selectTag für CL1 nötig um CL2 zu lesen.
  async readId() {
    const uid1 = await this.anticoll(PICC_SEL_CL1);
    if (!uid1) return null;

    if (uid1[0] !== 0x88) {
      // Normale 4-Byte-UID
      return {
        uid: uid1.slice(0, 4),
        uidHex: uid1.slice(0, 4).map(b => (b & 0xFF).toString(16).padStart(2, "0")).join(""),
      };
    }

    // Cascade: CL1 Select nötig um CL2 lesen zu können
    this._dbg("readId: Cascade (uid1[0]=0x88), starte CL2...");

    const sel1 = await this.selectTag(uid1, PICC_SEL_CL1);
    if (!sel1.ok) {
      this._dbg("readId: CL1 SELECT fehlgeschlagen");
      return null;
    }

    const uid2 = await this.anticoll(PICC_SEL_CL2);
    if (!uid2) {
      this._dbg("readId: CL2 anticoll fehlgeschlagen");
      return null;
    }

    const fullUid = [...uid1.slice(1, 4), ...uid2.slice(0, 4)];
    return {
      uid: fullUid,
      uidHex: fullUid.map(b => (b & 0xFF).toString(16).padStart(2, "0")).join(""),
    };
  }

  // halt() — Karte von ACTIVE nach HALT versetzen
  // Wird im Normalpfad NICHT aufgerufen.
  // Nur verfügbar für spezielle Anwendungsfälle.
  async halt() {
    try {
      const cmd = [PICC_HALT, 0x00];
      const crc = await this.calcCrc(cmd);
      cmd.push(crc[0], crc[1]);
      await this.cardWrite(PCD_TRANSCEIVE, cmd);
    } catch {}
    try {
      await this.clearBitmask(Status2Reg, 0x08);
    } catch {}
  }

  async stopCrypto() {
    await this.clearBitmask(Status2Reg, 0x08);
  }

  // ── Mifare Operationen (benötigen vorheriges selectTag) ──

  async mifareAuth(blockAddr, key6, uid4) {
    const buf = [PICC_AUTH_KEY_A, blockAddr];
    const keyArr = Buffer.isBuffer(key6) ? [...key6] : [...hexToBuf(key6)];
    if (keyArr.length !== 6) throw new Error("Key must be 6 bytes");
    buf.push(...keyArr);
    for (let i = 0; i < 4; i++) buf.push(uid4[i]);

    const { error } = await this.cardWrite(PCD_MFAUTHENT, buf);
    const s2 = await this.readReg(Status2Reg);
    if ((s2 & 0x08) === 0) return false;
    return !error;
  }

  async mifareRead(blockAddr) {
    const buf = [PICC_READ, blockAddr];
    const crc = await this.calcCrc(buf);
    buf.push(crc[0], crc[1]);
    const { error, backData } = await this.cardWrite(PCD_TRANSCEIVE, buf);
    if (error || backData.length !== 16) return null;
    return Buffer.from(backData);
  }

  async mifareWrite(blockAddr, data16) {
    const payload = ensure16Bytes(data16);
    const cmd = [PICC_WRITE, blockAddr];
    const crc1 = await this.calcCrc(cmd);
    cmd.push(crc1[0], crc1[1]);
    const res1 = await this.cardWrite(PCD_TRANSCEIVE, cmd);
    if (res1.error || res1.backBits !== 4 || (res1.backData[0] & 0x0F) !== 0x0A) {
      throw new Error("Write phase 1 failed");
    }
    const dataBuf = [...payload];
    const crc2 = await this.calcCrc(dataBuf);
    dataBuf.push(crc2[0], crc2[1]);
    const res2 = await this.cardWrite(PCD_TRANSCEIVE, dataBuf);
    if (res2.error || res2.backBits !== 4 || (res2.backData[0] & 0x0F) !== 0x0A) {
      throw new Error("Write phase 2 failed");
    }
    return true;
  }

  // ── Hilfsfunktionen ──

  static uidToHex(uid) {
    const arr = Array.isArray(uid) ? uid : [...uid];
    return arr.map(b => (b & 0xFF).toString(16).padStart(2, "0")).join("");
  }

  static bufToHex(buf) { return Buffer.from(buf).toString("hex"); }
  static isTrailerBlock(b) { return (Number(b) % 4) === 3; }
}

module.exports = { MFRC522, ensure16Bytes, hexToBuf };