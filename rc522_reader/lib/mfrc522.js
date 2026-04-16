// MFRC522 Node.js Treiber
// Orientiert an pi-rc522 (Python) von ondryaso
// Angepasst für: Clone-Module, langes Kabel, HAOS ohne RPi.GPIO
//
// Wichtig: Kein halt() und kein antennaReset() im Normalpfad.
// Der Polling-Zyklus ist: request(WUPA) → anticoll → UID lesen → fertig.
// Reset nur bei echten SPI-/Reader-Fehlern über softReset() + init().

const spi = require("spi-device");
const fs  = require("fs");

// ── PCD (Reader) Kommandos ──
const PCD_IDLE       = 0x00;
const PCD_CALC_CRC   = 0x03;
const PCD_TRANSCEIVE = 0x0C;
const PCD_MFAUTHENT  = 0x0E;
const PCD_SOFTRESET  = 0x0F;

// ── PICC (Karte) Kommandos ──
const PICC_REQA       = 0x26;
const PICC_WUPA       = 0x52;
const PICC_HALT       = 0x50;
const PICC_SEL_CL1    = 0x93;
const PICC_SEL_CL2    = 0x95;
const PICC_ANTICOLL   = 0x20;
const PICC_SELECT     = 0x70;
const PICC_AUTH_KEY_A = 0x60;
const PICC_READ       = 0x30;
const PICC_WRITE      = 0xA0;

// ── Register ──
const CommandReg     = 0x01;
const ComIEnReg      = 0x02;
const ComIrqReg      = 0x04;
const DivIrqReg      = 0x05;
const ErrorReg       = 0x06;
const Status2Reg     = 0x08;
const FIFODataReg    = 0x09;
const FIFOLevelReg   = 0x0A;
const ControlReg     = 0x0C;
const BitFramingReg  = 0x0D;
const CollReg        = 0x0E;
const ModeReg        = 0x11;
const TxControlReg   = 0x14;
const TxASKReg       = 0x15;
const CRCResultRegH  = 0x21;
const CRCResultRegL  = 0x22;
const RFCfgReg       = 0x26;
const TModeReg       = 0x2A;
const TPrescalerReg  = 0x2B;
const TReloadRegH    = 0x2C;
const TReloadRegL    = 0x2D;

// Register-Namen für Debug
const REG_NAMES = {
  0x01: "CommandReg", 0x02: "ComIEnReg", 0x04: "ComIrqReg",
  0x05: "DivIrqReg", 0x06: "ErrorReg", 0x08: "Status2Reg",
  0x09: "FIFODataReg", 0x0A: "FIFOLevelReg", 0x0C: "ControlReg",
  0x0D: "BitFramingReg", 0x0E: "CollReg", 0x11: "ModeReg",
  0x14: "TxControlReg", 0x15: "TxASKReg", 0x21: "CRCResultRegH",
  0x22: "CRCResultRegL", 0x26: "RFCfgReg", 0x2A: "TModeReg",
  0x2B: "TPrescalerReg", 0x2C: "TReloadRegH", 0x2D: "TReloadRegL",
};

function addrW(reg) { return (reg << 1) & 0x7E; }
function addrR(reg) { return ((reg << 1) & 0x7E) | 0x80; }
function hex(v) { return "0x" + (v & 0xFF).toString(16).padStart(2, "0"); }
function hexArr(arr) { return arr.map(b => hex(b)).join(" "); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hexToBuf(h) {
  const clean = String(h).trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  return Buffer.from(clean, "hex");
}

function ensure16Bytes(data) {
  let buf = Buffer.isBuffer(data) ? Buffer.from(data) : hexToBuf(data);
  if (buf.length > 16) buf = buf.subarray(0, 16);
  if (buf.length < 16) {
    const out = Buffer.alloc(16, 0x00);
    buf.copy(out, 0);
    buf = out;
  }
  return buf;
}

class MFRC522 {
  constructor(opts) {
    this.bus     = Number(opts.bus     ?? 0);
    this.device  = Number(opts.device  ?? 0);
    this.speedHz = Number(opts.speedHz ?? 100_000);
    this.antennaGain = Number(opts.antennaGain ?? 0x04); // 33 dB
    this.debug   = Boolean(opts.debug ?? false);
    this.dev     = null;

    this._stats = {
      polls: 0,
      requests: 0,
      requestOk: 0,
      requestFail: 0,
      anticolls: 0,
      anticollOk: 0,
      anticollFail: 0,
      cardWriteCalls: 0,
      cardWriteErrors: 0,
      cardWriteTimeouts: 0,
    };
  }

  _dbg(...args) {
    if (this.debug) console.log("[RC522:DBG]", ...args);
  }

  statsLine() {
    const s = this._stats;
    return `polls=${s.polls} req=${s.requestOk}/${s.requests} ` +
           `anti=${s.anticollOk}/${s.anticolls} ` +
           `cw=${s.cardWriteCalls}(err:${s.cardWriteErrors} to:${s.cardWriteTimeouts})`;
  }

  // ── SPI ──

  open() {
    if (this.dev) return;
    this.dev = spi.openSync(this.bus, this.device, {
      mode: 0,
      maxSpeedHz: this.speedHz,
    });
  }

  close() {
    if (!this.dev) return;
    try { this.dev.closeSync(); } catch {}
    this.dev = null;
  }

  async _xfer(txBuf) {
    return new Promise((resolve, reject) => {
      const msg = [{
        sendBuffer: txBuf,
        receiveBuffer: Buffer.alloc(txBuf.length),
        byteLength: txBuf.length,
        speedHz: this.speedHz,
      }];
      this.dev.transfer(msg, (err, m) => {
        if (err) return reject(err);
        resolve(m[0].receiveBuffer);
      });
    });
  }

  async writeReg(reg, val) {
    await this._xfer(Buffer.from([addrW(reg), val & 0xFF]));
  }

  async readReg(reg) {
    const rx = await this._xfer(Buffer.from([addrR(reg), 0x00]));
    return rx[1];
  }

  async setBitmask(reg, mask) {
    const cur = await this.readReg(reg);
    await this.writeReg(reg, cur | mask);
  }

  async clearBitmask(reg, mask) {
    const cur = await this.readReg(reg);
    await this.writeReg(reg, cur & ~mask);
  }

  async fifoWrite(data) {
    for (let i = 0; i < data.length; i++) {
      await this.writeReg(FIFODataReg, data[i]);
    }
  }

  async fifoRead(n) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      out[i] = await this.readReg(FIFODataReg);
    }
    return out;
  }

  // ── Hardware-Reset (GPIO 25, BCM2835/BCM2711) ──

  async hardwareReset() {
    let fd;
    try {
      fd = fs.openSync("/dev/gpiomem0", "r+");
      const mem = Buffer.alloc(4 * 64);
      fs.readSync(fd, mem, 0, mem.length, 0);

      const fselOff = 2 * 4;
      let fsel = mem.readUInt32LE(fselOff);
      fsel &= ~(0b111 << 15);
      fsel |=  (0b001 << 15);
      mem.writeUInt32LE(fsel, fselOff);
      fs.writeSync(fd, mem, fselOff, 4, fselOff);

      const pinBit = 1 << 25;
      const setPin = (high) => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(pinBit, 0);
        fs.writeSync(fd, buf, 0, 4, (high ? 7 : 10) * 4);
      };

      setPin(true);  await sleep(10);
      setPin(false); await sleep(10);
      setPin(true);  await sleep(50);
      console.log("RC522: Hardware-Reset GPIO 25 OK");
    } catch (e) {
      console.warn("RC522: GPIO Reset fehlgeschlagen:", e.message);
      console.warn("RC522: Starte ohne Hardware-Reset weiter...");
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  // ── Init ──

  async softReset() {
    await this.writeReg(CommandReg, PCD_SOFTRESET);
    await sleep(150);
  }

  async setAntennaGain(gain) {
    this.antennaGain = gain;
    await this.writeReg(RFCfgReg, (gain & 0x07) << 4);
  }

  async setAntenna(on) {
    if (on) {
      const cur = await this.readReg(TxControlReg);
      if ((cur & 0x03) !== 0x03) {
        await this.setBitmask(TxControlReg, 0x03);
      }
    } else {
      await this.clearBitmask(TxControlReg, 0x03);
    }
  }

  async init() {
    await this.hardwareReset();
    await this.softReset();

    const check = await this.readReg(ModeReg);
    if (check === 0xFF || check === 0x00) {
      throw new Error(
        `RC522 antwortet nicht! ModeReg=${hex(check)}\n` +
        `→ Verkabelung prüfen (/dev/spidev${this.bus}.${this.device})\n` +
        `→ RST-Pin prüfen: GPIO 25\n` +
        `→ Spannung prüfen: muss 3.3V sein, niemals 5V!`
      );
    }
    console.log(`RC522: SPI OK (ModeReg=${hex(check)})`);

    await this.writeReg(TModeReg,      0x8D);
    await this.writeReg(TPrescalerReg, 0x3E);
    await this.writeReg(TReloadRegL,   30);
    await this.writeReg(TReloadRegH,   0);
    await this.writeReg(TxASKReg,      0x40);
    await this.writeReg(ModeReg,       0x3D);

    await this.setAntennaGain(this.antennaGain);
    await this.setAntenna(true);

    if (this.debug) {
      const regs = [CommandReg, ComIEnReg, ModeReg, TxControlReg, TxASKReg,
                    RFCfgReg, TModeReg, TPrescalerReg, Status2Reg];
      const dump = [];
      for (const reg of regs) {
        const val = await this.readReg(reg);
        dump.push(`${REG_NAMES[reg] || hex(reg)}=${hex(val)}`);
      }
      this._dbg("Register nach Init:", dump.join(", "));
    }
  }

  // ── Diagnose ──

  async dumpState(label) {
    if (!this.debug) return;
    try {
      const cmd  = await this.readReg(CommandReg);
      const irq  = await this.readReg(ComIrqReg);
      const err  = await this.readReg(ErrorReg);
      const s2   = await this.readReg(Status2Reg);
      const fifo = await this.readReg(FIFOLevelReg);
      const txc  = await this.readReg(TxControlReg);
      const coll = await this.readReg(CollReg);
      this._dbg(
        `[${label}] Cmd=${hex(cmd)} IRQ=${hex(irq)} Err=${hex(err)} ` +
        `S2=${hex(s2)} FIFO=${fifo} TxCtrl=${hex(txc)} Coll=${hex(coll)}`
      );
    } catch (e) {
      this._dbg(`[${label}] dumpState fehlgeschlagen: ${e?.message}`);
    }
  }

  // ── CRC (wie pi-rc522) ──

  async calcCrc(data) {
    await this.clearBitmask(DivIrqReg, 0x04);
    await this.setBitmask(FIFOLevelReg, 0x80);
    await this.fifoWrite(data);
    await this.writeReg(CommandReg, PCD_CALC_CRC);

    let i = 255;
    while (true) {
      const n = await this.readReg(DivIrqReg);
      i--;
      if ((n & 0x04) || i <= 0) break;
    }
    if (i <= 0) this._dbg("calcCrc: Timeout");

    const lo = await this.readReg(CRCResultRegL);
    const hi = await this.readReg(CRCResultRegH);
    return [lo, hi];
  }

  // ── cardWrite (1:1 wie pi-rc522) ──

  async cardWrite(command, data) {
    this._stats.cardWriteCalls++;

    let backData = [];
    let backBits = 0;
    let error = true;
    let errReg = 0;

    let irqEn = 0x00;
    let irqWait = 0x00;

    if (command === PCD_MFAUTHENT) { irqEn = 0x12; irqWait = 0x10; }
    if (command === PCD_TRANSCEIVE) { irqEn = 0x77; irqWait = 0x30; }

    await this.writeReg(ComIEnReg, irqEn | 0x80);
    await this.clearBitmask(ComIrqReg, 0x80);
    await this.setBitmask(FIFOLevelReg, 0x80);
    await this.writeReg(CommandReg, PCD_IDLE);

    await this.fifoWrite(data);
    await this.writeReg(CommandReg, command);

    if (command === PCD_TRANSCEIVE) {
      await this.setBitmask(BitFramingReg, 0x80);
    }

    let n;
    let i = 2000;
    while (true) {
      n = await this.readReg(ComIrqReg);
      i--;
      if (i <= 0) break;
      if (n & 0x01) break;
      if (n & irqWait) break;
    }

    await this.clearBitmask(BitFramingReg, 0x80);

    if (i <= 0) {
      this._stats.cardWriteTimeouts++;
      this._dbg(`cardWrite: Timeout, IRQ=${hex(n)}, tx=[${hexArr(data)}]`);
    }

    if (i > 0) {
      errReg = await this.readReg(ErrorReg);
      if ((errReg & 0x1B) === 0x00) {
        error = false;

        if (n & irqEn & 0x01) {
          error = true;
          this._dbg(`cardWrite: TimerIRq, tx=[${hexArr(data)}]`);
        }

        if (command === PCD_TRANSCEIVE) {
          let nn = await this.readReg(FIFOLevelReg);
          const lastBits = (await this.readReg(ControlReg)) & 0x07;

          if (lastBits !== 0) {
            backBits = (nn - 1) * 8 + lastBits;
          } else {
            backBits = nn * 8;
          }

          if (nn === 0) nn = 1;
          if (nn > 16) nn = 16;

          const fifoData = await this.fifoRead(nn);
          for (let j = 0; j < nn; j++) backData.push(fifoData[j]);
        }
      } else {
        error = true;
        this._stats.cardWriteErrors++;
        this._dbg(
          `cardWrite: ErrorReg=${hex(errReg)} ` +
          `(${(errReg & 0x01) ? "Protocol " : ""}` +
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
  // Für 7-Byte-UIDs: selectTag für CL1 nötig, dann CL2 anticoll.
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
  // Nur verfügbar für spezielle Anwendungsfälle (nach selectTag + Mifare-Ops).
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