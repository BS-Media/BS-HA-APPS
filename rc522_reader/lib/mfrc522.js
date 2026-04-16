// Was wurde geändert (und warum):
//   1. fs importiert          → für direkten /dev/gpiomem0 Zugriff (GPIO Reset)
//   2. speedHz = 100_000      → 100 kHz statt 1 MHz, Clone-Module sind sonst überfordert
//   3. hardwareReset()        → zieht RST GPIO 25 kurz auf LOW via /dev/gpiomem0
//   4. softReset delay 150ms  → Clone brauchen länger als Original-Chips
//   5. Sanity-Check in init() → prüft ob SPI überhaupt funktioniert, klare Fehlermeldung
//   6. haltA()                → Karte nach Lesung in HALT versetzen (ISO 14443)
//   7. stopCrypto1()          → Crypto-Flag zurücksetzen nach Auth
//   8. antennaReset()         → RF-Feld kurz aus/ein — erzwingt neuen Kartenzustand
//   9. Kollisions-Toleranz    → REQA wirft bei CollErr keine Exception mehr
//  10. Retry-Logik in readFifoBytes → toleriert einzelne SPI-Glitches

const spi = require("spi-device");
const fs  = require("fs"); // ← für /dev/gpiomem

// ---------- MFRC522 Befehle ----------
const PCD_IDLE       = 0x00;
const PCD_CALC_CRC   = 0x03;
const PCD_TRANSCEIVE = 0x0C;
const PCD_MFAUTHENT  = 0x0E;
const PCD_SOFTRESET  = 0x0F;

// ---------- PICC Befehle ----------
const PICC_CMD_REQA          = 0x26;
const PICC_CMD_WUPA          = 0x52;  // ← NEU: Wake-Up statt REQA
const PICC_CMD_HLTA          = 0x50;  // ← NEU: Halt-Kommando
const PICC_CMD_SEL_CL1       = 0x93;
const PICC_CMD_ANTICOLL_CL1  = 0x20;
const PICC_CMD_SELECT_CL1    = 0x70;
const PICC_CMD_MF_AUTH_KEY_A = 0x60;
const PICC_CMD_MF_READ       = 0x30;
const PICC_CMD_MF_WRITE      = 0xA0;

// ---------- Register ----------
const CommandReg    = 0x01;
const ComIrqReg     = 0x04;
const DivIrqReg     = 0x05;
const ErrorReg      = 0x06;
const Status2Reg    = 0x08;
const FIFODataReg   = 0x09;
const FIFOLevelReg  = 0x0A;
const ControlReg    = 0x0C;
const BitFramingReg = 0x0D;
const CollReg       = 0x0E;
const ModeReg       = 0x11;
const TxControlReg  = 0x14;
const TxASKReg      = 0x15;
const TModeReg      = 0x2A;
const TPrescalerReg = 0x2B;
const TReloadRegH   = 0x2C;
const TReloadRegL   = 0x2D;
const CRCResultRegH = 0x21;
const CRCResultRegL = 0x22;

// ---------- Bit-Masken ----------
const FIFO_FLUSH_MASK    = 0x80;
const START_SEND_MASK    = 0x80;
const STATUS2_CRYPTO1_ON = 0x08;

function addrWrite(reg) { return (reg << 1) & 0x7E; }
function addrRead(reg)  { return ((reg << 1) & 0x7E) | 0x80; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hexToBuf(hex) {
  const clean = String(hex).trim().toLowerCase().replace(/[^0-9a-f]/g, "");
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
    this.dev     = null;
  }

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
      const message = [{
        sendBuffer: txBuf,
        receiveBuffer: Buffer.alloc(txBuf.length),
        byteLength: txBuf.length,
        speedHz: this.speedHz,
      }];
      this.dev.transfer(message, (err, msg) => {
        if (err) return reject(err);
        resolve(msg[0].receiveBuffer);
      });
    });
  }

  async writeReg(reg, value) {
    await this._xfer(Buffer.from([addrWrite(reg), value & 0xFF]));
  }

  async readReg(reg) {
    const rx = await this._xfer(Buffer.from([addrRead(reg), 0x00]));
    return rx[1];
  }

  async writeRegMany(reg, dataBuf) {
    const tx = Buffer.alloc(1 + dataBuf.length);
    tx[0] = addrWrite(reg);
    dataBuf.copy(tx, 1);
    await this._xfer(tx);
  }

  // FIFO einzeln auslesen — mit Retry bei Glitch
  async readFifoBytes(n) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      let val = await this.readReg(FIFODataReg);
      // Bei 0xFF nochmal versuchen (typischer SPI-Glitch bei langem Kabel)
      if (val === 0xFF && n <= 5) {
        await sleep(1);
        val = await this.readReg(FIFODataReg);
      }
      out[i] = val;
    }
    return out;
  }

  async fifoFlush() { await this.writeReg(FIFOLevelReg, FIFO_FLUSH_MASK); }
  async fifoLevel() { return await this.readReg(FIFOLevelReg); }

  // ── NEU: Antenne kurz aus/ein → RF-Feld wird neu aufgebaut ──
  // Dadurch vergessen alle Karten im Feld ihren Zustand und sind wieder ansprechbar
  async antennaReset() {
    const v = await this.readReg(TxControlReg);
    await this.writeReg(TxControlReg, v & ~0x03); // Antenne AUS
    await sleep(50);                                // 50ms reicht für Feld-Abbau
    await this.writeReg(TxControlReg, v | 0x03);  // Antenne AN
    await sleep(10);                                // kurz stabilisieren lassen
  }

  // ── NEU: Crypto1-Flag zurücksetzen ──
  // Nach einer Mifare-Authentifizierung bleibt Crypto1 aktiv.
  // Das muss zurückgesetzt werden, sonst funktionieren danach keine normalen Befehle.
  async stopCrypto1() {
    const s2 = await this.readReg(Status2Reg);
    if (s2 & STATUS2_CRYPTO1_ON) {
      await this.writeReg(Status2Reg, s2 & ~STATUS2_CRYPTO1_ON);
    }
  }

  // ── NEU: HaltA — Karte in den HALT-Zustand schicken ──
  // Eine gehaltete Karte reagiert nicht mehr auf REQA, aber auf WUPA.
  // Das ist wichtig, damit dieselbe Karte beim nächsten Poll wieder erkannt werden kann.
  async haltA() {
    try {
      const cmd = Buffer.from([PICC_CMD_HLTA, 0x00]);
      const crc = await this.calcCrc(cmd);
      // HaltA bekommt absichtlich keine gültige Antwort — Timeout ist normal
      await this.transceive(Buffer.concat([cmd, crc]), 0, 50, true);
    } catch {
      // Timeout/Fehler ist hier erwartet und OK
    }
    await this.stopCrypto1();
  }

  // Hardware-Reset über /dev/gpiomem
  async hardwareReset() {
    const GPFSEL2 = 2;
    const GPSET0  = 7;
    const GPCLR0  = 10;

    let fd;
    try {
      fd = fs.openSync("/dev/gpiomem0", "r+");

      const mem = Buffer.alloc(4 * 64);
      fs.readSync(fd, mem, 0, mem.length, 0);

      const fselOffset = GPFSEL2 * 4;
      let fsel = mem.readUInt32LE(fselOffset);
      fsel &= ~(0b111 << 15);
      fsel |=  (0b001 << 15);
      mem.writeUInt32LE(fsel, fselOffset);
      fs.writeSync(fd, mem, fselOffset, 4, fselOffset);

      const pinBit = 1 << 25;

      const setHigh = () => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(pinBit, 0);
        fs.writeSync(fd, buf, 0, 4, GPSET0 * 4);
      };
      const setLow = () => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(pinBit, 0);
        fs.writeSync(fd, buf, 0, 4, GPCLR0 * 4);
      };

      setHigh();
      await sleep(10);
      setLow();
      await sleep(10);
      setHigh();
      await sleep(50);

      console.log(`RC522: Hardware-Reset GPIO 25 OK`);

    } catch (e) {
      console.warn(`RC522: GPIO Reset fehlgeschlagen:`, e.message);
      console.warn(`RC522: Starte ohne Hardware-Reset weiter...`);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  async softReset() {
    await this.writeReg(CommandReg, PCD_SOFTRESET);
    await sleep(150);
  }

  async antennaOn() {
    const v = await this.readReg(TxControlReg);
    if ((v & 0x03) !== 0x03) await this.writeReg(TxControlReg, v | 0x03);
  }

  async init() {
    await this.hardwareReset();
    await this.softReset();

    const check = await this.readReg(ModeReg);
    if (check === 0xFF || check === 0x00) {
      throw new Error(
        `RC522 antwortet nicht! ModeReg=0x${check.toString(16)}\n` +
        `→ Verkabelung prüfen (/dev/spidev${this.bus}.${this.device})\n` +
        `→ RST-Pin prüfen: GPIO 25\n` +
        `→ Spannung prüfen: muss 3.3V sein, niemals 5V!`
      );
    }
    console.log(`RC522: SPI OK (ModeReg=0x${check.toString(16)})`);

    await this.writeReg(TModeReg,      0x8D);
    await this.writeReg(TPrescalerReg, 0x3E);
    await this.writeReg(TReloadRegL,   30);
    await this.writeReg(TReloadRegH,   0);
    await this.writeReg(TxASKReg,      0x40);
    await this.writeReg(ModeReg,       0x3D);

    await this.antennaOn();
  }

  async calcCrc(dataBuf) {
    await this.writeReg(CommandReg, PCD_IDLE);
    await this.writeReg(DivIrqReg, 0x04);
    await this.fifoFlush();
    await this.writeRegMany(FIFODataReg, dataBuf);
    await this.writeReg(CommandReg, PCD_CALC_CRC);

    const t0 = Date.now();
    while (true) {
      const n = await this.readReg(DivIrqReg);
      if (n & 0x04) break;
      if (Date.now() - t0 > 50) throw new Error("CRC timeout");
    }

    const crcL = await this.readReg(CRCResultRegL);
    const crcH = await this.readReg(CRCResultRegH);
    return Buffer.from([crcL, crcH]);
  }

  // GEÄNDERT: neuer Parameter ignoreCollision
  async transceive(txBuf, validBitsLastByte = 0, timeoutMs = 200, ignoreCollision = false) {
    await this.writeReg(CommandReg, PCD_IDLE);
    await this.writeReg(ComIrqReg, 0x7F);
    await this.fifoFlush();
    await this.writeRegMany(FIFODataReg, txBuf);

    const txLastBits = validBitsLastByte & 0x07;
    await this.writeReg(BitFramingReg, txLastBits);
    await this.writeReg(CommandReg, PCD_TRANSCEIVE);

    // GEÄNDERT: kurzes Delay vor StartSend — gibt dem Chip Zeit sich vorzubereiten
    await sleep(1);
    await this.writeReg(BitFramingReg, txLastBits | START_SEND_MASK);

    const t0 = Date.now();
    let irq = 0;

    while (true) {
      irq = await this.readReg(ComIrqReg);
      if (irq & 0x20) break;
      if (irq & 0x01) return { data: Buffer.alloc(0), rxLastBits: 0, errorReg: await this.readReg(ErrorReg), irqReg: irq, fifo: 0, note: "TimerIRq" };
      if (Date.now() - t0 > timeoutMs) return { data: Buffer.alloc(0), rxLastBits: 0, errorReg: await this.readReg(ErrorReg), irqReg: irq, fifo: 0, note: "Timeout" };
    }

    await this.writeReg(BitFramingReg, 0x00);

    const err = await this.readReg(ErrorReg);
    // GEÄNDERT: Bei ignoreCollision wird CollErr (0x08) nicht als Fehler gewertet
    const mask = ignoreCollision ? 0x13 : 0x1B;
    if (err & mask) throw new Error(`Transceive ErrorReg=0x${err.toString(16)}`);

    const n = await this.fifoLevel();
    const rxData = n > 0 ? await this.readFifoBytes(n) : Buffer.alloc(0);
    const ctrl = await this.readReg(ControlReg);
    const rxLastBits = ctrl & 0x07;

    return { data: rxData, rxLastBits, errorReg: err, irqReg: irq, fifo: n };
  }

  // ---------- PICC Helfer ----------

  // GEÄNDERT: benutzt WUPA statt REQA — weckt auch gehaltete Karten auf
  // + ignoreCollision = true
  async requestA() {
    try {
      const res = await this.transceive(Buffer.from([PICC_CMD_WUPA]), 7, 80, true);
      if (res.data.length !== 2) return null;
      return res.data;
    } catch {
      return null;
    }
  }

  async anticollCL1() {
    try {
      await this.writeReg(CollReg, 0x80);
      const res = await this.transceive(
        Buffer.from([PICC_CMD_SEL_CL1, PICC_CMD_ANTICOLL_CL1]), 0, 80, true
      );
      if (res.data.length < 5) return null;

      const uid4 = res.data.subarray(0, 4);
      const bcc  = res.data[4];
      const calc = uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3];
      if (calc !== bcc) return null;

      return Buffer.from(uid4);
    } catch {
      return null;
    }
  }

  async selectCL1(uid4) {
    const bcc   = uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3];
    const frame = Buffer.from([
      PICC_CMD_SEL_CL1, PICC_CMD_SELECT_CL1,
      uid4[0], uid4[1], uid4[2], uid4[3], bcc,
    ]);
    const crc = await this.calcCrc(frame);
    const res = await this.transceive(Buffer.concat([frame, crc]), 0, 80);
    if (res.data.length < 1) return null;
    return { sak: res.data[0], raw: res.data };
  }

  async mifareAuthKeyA(blockAddr, key6, uid4) {
    const block  = Number(blockAddr);
    let keyBuf   = Buffer.isBuffer(key6) ? key6 : hexToBuf(key6);
    if (keyBuf.length !== 6) throw new Error("Key A must be 6 bytes");

    const authFrame = Buffer.concat([
      Buffer.from([PICC_CMD_MF_AUTH_KEY_A, block]),
      keyBuf, uid4,
    ]);

    await this.writeReg(CommandReg, PCD_IDLE);
    await this.writeReg(ComIrqReg, 0x7F);
    await this.fifoFlush();
    await this.writeRegMany(FIFODataReg, authFrame);
    await this.writeReg(CommandReg, PCD_MFAUTHENT);

    const t0 = Date.now();
    while (true) {
      const irq = await this.readReg(ComIrqReg);
      if (irq & 0x10) break;
      if (irq & 0x01) break;
      if (Date.now() - t0 > 150) break;
    }

    const err = await this.readReg(ErrorReg);
    if (err & 0x1B) throw new Error(`Auth ErrorReg=0x${err.toString(16)}`);

    const s2 = await this.readReg(Status2Reg);
    if ((s2 & STATUS2_CRYPTO1_ON) === 0) throw new Error("Auth failed (Crypto1Off)");
    return true;
  }

  async mifareReadBlock(blockAddr) {
    const block = Number(blockAddr);
    const cmd   = Buffer.from([PICC_CMD_MF_READ, block]);
    const crc   = await this.calcCrc(cmd);
    const res   = await this.transceive(Buffer.concat([cmd, crc]), 0, 250);
    if (res.data.length < 16) throw new Error(`Read returned ${res.data.length} bytes`);
    return res.data.subarray(0, 16);
  }

  static isMifareAck(res) {
    if (!res || res.data.length < 1) return false;
    const b      = res.data[0] & 0x0F;
    const bitsOk = (res.rxLastBits === 4) || (res.rxLastBits === 0);
    return bitsOk && (b === 0x0A);
  }

  async mifareWriteBlock(blockAddr, data16) {
    const block   = Number(blockAddr);
    const payload = ensure16Bytes(data16);

    const cmd1 = Buffer.from([PICC_CMD_MF_WRITE, block]);
    const crc1 = await this.calcCrc(cmd1);
    const res1 = await this.transceive(Buffer.concat([cmd1, crc1]), 0, 250);
    if (!MFRC522.isMifareAck(res1)) {
      throw new Error(`No ACK on write phase1 (data=${res1.data.toString("hex")} rxLastBits=${res1.rxLastBits})`);
    }

    const crc2 = await this.calcCrc(payload);
    const res2 = await this.transceive(Buffer.concat([payload, crc2]), 0, 400);
    if (!MFRC522.isMifareAck(res2)) {
      throw new Error(`No ACK on write phase2 (data=${res2.data.toString("hex")} rxLastBits=${res2.rxLastBits})`);
    }
    return true;
  }

  static uidToHex(uidBuf) { return Buffer.from(uidBuf).toString("hex"); }
  static bufToHex(buf)     { return Buffer.from(buf).toString("hex"); }
  static isTrailerBlock(b) { return (Number(b) % 4) === 3; }
}

module.exports = { MFRC522, ensure16Bytes, hexToBuf };