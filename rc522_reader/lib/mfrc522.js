// lib/mfrc522.js
// Pure JS MFRC522 (RC522) for Raspberry Pi 5 via spi-device.
// Includes: REQA, ANTICOLL CL1 (FIFO read fix), SELECT CL1, AUTH KeyA, READ, WRITE (2-phase ACK).

// aus: https://github.com/marcschweitzer/node-red-contrib-raspi5-rc522
// und: https://flows.nodered.org/node/node-red-contrib-raspi5-rc522

const spi = require("spi-device");

// ---------- MFRC522 commands ----------
const PCD_IDLE       = 0x00;
const PCD_CALC_CRC   = 0x03;
const PCD_TRANSCEIVE = 0x0C;
const PCD_MFAUTHENT  = 0x0E;
const PCD_SOFTRESET  = 0x0F;

// ---------- PICC commands ----------
const PICC_CMD_REQA           = 0x26;
const PICC_CMD_SEL_CL1        = 0x93;
const PICC_CMD_ANTICOLL_CL1   = 0x20;
const PICC_CMD_SELECT_CL1     = 0x70;

const PICC_CMD_MF_AUTH_KEY_A  = 0x60;
const PICC_CMD_MF_READ        = 0x30;
const PICC_CMD_MF_WRITE       = 0xA0;

// ---------- Registers ----------
const CommandReg     = 0x01;
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
const TModeReg       = 0x2A;
const TPrescalerReg  = 0x2B;
const TReloadRegH    = 0x2C;
const TReloadRegL    = 0x2D;

// CRC result registers
const CRCResultRegH  = 0x21;
const CRCResultRegL  = 0x22;

// ---------- Bit masks ----------
const FIFO_FLUSH_MASK = 0x80;
const START_SEND_MASK = 0x80;
const STATUS2_CRYPTO1_ON = 0x08; // Status2Reg bit 3

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
    this.bus = Number(opts.bus ?? 1);
    this.device = Number(opts.device ?? 0);
    this.speedHz = Number(opts.speedHz ?? 1_000_000);
    this.dev = null;
  }

  open() {
    if (this.dev) return;
    this.dev = spi.openSync(this.bus, this.device, { mode: 0, maxSpeedHz: this.speedHz });
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
        speedHz: this.speedHz
      }];
      this.dev.transfer(message, (err, msg) => {
        if (err) return reject(err);
        resolve(msg[0].receiveBuffer);
      });
    });
  }

  async writeReg(reg, value) { await this._xfer(Buffer.from([addrWrite(reg), value & 0xFF])); }
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

  // FIFO read fix: read bytes one-by-one (some RC522 clones break on burst reads)
  async readFifoBytes(n) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = await this.readReg(FIFODataReg);
    return out;
  }

  async fifoFlush() { await this.writeReg(FIFOLevelReg, FIFO_FLUSH_MASK); }
  async fifoLevel() { return await this.readReg(FIFOLevelReg); }

  async softReset() {
    await this.writeReg(CommandReg, PCD_SOFTRESET);
    await sleep(50);
  }
  async antennaOn() {
    const v = await this.readReg(TxControlReg);
    if ((v & 0x03) !== 0x03) await this.writeReg(TxControlReg, v | 0x03);
  }

  async init() {
    await this.softReset();
    await this.writeReg(TModeReg, 0x8D);
    await this.writeReg(TPrescalerReg, 0x3E);
    await this.writeReg(TReloadRegL, 30);
    await this.writeReg(TReloadRegH, 0);
    await this.writeReg(TxASKReg, 0x40);
    await this.writeReg(ModeReg, 0x3D);
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

  async transceive(txBuf, validBitsLastByte = 0, timeoutMs = 200) {
    await this.writeReg(CommandReg, PCD_IDLE);
    await this.writeReg(ComIrqReg, 0x7F);
    await this.fifoFlush();

    await this.writeRegMany(FIFODataReg, txBuf);

    const txLastBits = validBitsLastByte & 0x07;
    await this.writeReg(BitFramingReg, txLastBits);

    await this.writeReg(CommandReg, PCD_TRANSCEIVE);
    await this.writeReg(BitFramingReg, txLastBits | START_SEND_MASK);

    const t0 = Date.now();
    let irq = 0;

    while (true) {
      irq = await this.readReg(ComIrqReg);
      if (irq & 0x20) break; // RxIRq
      if (irq & 0x01) return { data: Buffer.alloc(0), rxLastBits: 0, errorReg: await this.readReg(ErrorReg), irqReg: irq, fifo: 0, note: "TimerIRq" };
      if (Date.now() - t0 > timeoutMs) return { data: Buffer.alloc(0), rxLastBits: 0, errorReg: await this.readReg(ErrorReg), irqReg: irq, fifo: 0, note: "Timeout" };
    }

    await this.writeReg(BitFramingReg, 0x00);

    const err = await this.readReg(ErrorReg);
    if (err & 0x1B) throw new Error(`Transceive ErrorReg=0x${err.toString(16)}`);

    const n = await this.fifoLevel();
    const rxData = n > 0 ? await this.readFifoBytes(n) : Buffer.alloc(0);

    const ctrl = await this.readReg(ControlReg);
    const rxLastBits = ctrl & 0x07;

    return { data: rxData, rxLastBits, errorReg: err, irqReg: irq, fifo: n };
  }

  // ---------- PICC helpers ----------
  async requestA() {
    const res = await this.transceive(Buffer.from([PICC_CMD_REQA]), 7, 80);
    if (res.data.length !== 2) return null;
    return res.data; // ATQA
  }

  async anticollCL1() {
    await this.writeReg(CollReg, 0x80);
    const res = await this.transceive(Buffer.from([PICC_CMD_SEL_CL1, PICC_CMD_ANTICOLL_CL1]), 0, 80);
    if (res.data.length < 5) return null;

    const uid4 = res.data.subarray(0, 4);
    const bcc = res.data[4];
    const calc = uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3];
    if (calc !== bcc) return null;

    return Buffer.from(uid4);
  }

  async selectCL1(uid4) {
    const bcc = uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3];
    const frame = Buffer.from([PICC_CMD_SEL_CL1, PICC_CMD_SELECT_CL1, uid4[0], uid4[1], uid4[2], uid4[3], bcc]);
    const crc = await this.calcCrc(frame);
    const res = await this.transceive(Buffer.concat([frame, crc]), 0, 80);
    if (res.data.length < 1) return null;
    return { sak: res.data[0], raw: res.data };
  }

  async mifareAuthKeyA(blockAddr, key6, uid4) {
    const block = Number(blockAddr);
    let keyBuf = Buffer.isBuffer(key6) ? key6 : hexToBuf(key6);
    if (keyBuf.length !== 6) throw new Error("Key A must be 6 bytes");
    const authFrame = Buffer.concat([Buffer.from([PICC_CMD_MF_AUTH_KEY_A, block]), keyBuf, uid4]);

    await this.writeReg(CommandReg, PCD_IDLE);
    await this.writeReg(ComIrqReg, 0x7F);
    await this.fifoFlush();
    await this.writeRegMany(FIFODataReg, authFrame);

    await this.writeReg(CommandReg, PCD_MFAUTHENT);

    const t0 = Date.now();
    while (true) {
      const irq = await this.readReg(ComIrqReg);
      if (irq & 0x10) break; // IdleIRq
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
    const cmd = Buffer.from([PICC_CMD_MF_READ, block]);
    const crc = await this.calcCrc(cmd);
    const res = await this.transceive(Buffer.concat([cmd, crc]), 0, 250);
    if (res.data.length < 16) throw new Error(`Read returned ${res.data.length} bytes`);
    return res.data.subarray(0, 16);
  }

  static isMifareAck(res) {
    if (!res || res.data.length < 1) return false;
    const b = res.data[0] & 0x0F;
    const bitsOk = (res.rxLastBits === 4) || (res.rxLastBits === 0);
    return bitsOk && (b === 0x0A);
  }

  async mifareWriteBlock(blockAddr, data16) {
    const block = Number(blockAddr);
    const payload = ensure16Bytes(data16);

    // Phase 1
    const cmd1 = Buffer.from([PICC_CMD_MF_WRITE, block]);
    const crc1 = await this.calcCrc(cmd1);
    const res1 = await this.transceive(Buffer.concat([cmd1, crc1]), 0, 250);
    if (!MFRC522.isMifareAck(res1)) {
      throw new Error(`No ACK on write phase1 (data=${res1.data.toString("hex")} rxLastBits=${res1.rxLastBits})`);
    }

    // Phase 2
    const crc2 = await this.calcCrc(payload);
    const res2 = await this.transceive(Buffer.concat([payload, crc2]), 0, 400);
    if (!MFRC522.isMifareAck(res2)) {
      throw new Error(`No ACK on write phase2 (data=${res2.data.toString("hex")} rxLastBits=${res2.rxLastBits})`);
    }
    return true;
  }

  static uidToHex(uidBuf) { return Buffer.from(uidBuf).toString("hex"); }
  static bufToHex(buf) { return Buffer.from(buf).toString("hex"); }
  static isTrailerBlock(block) { return (Number(block) % 4) === 3; }
}

module.exports = { MFRC522, ensure16Bytes, hexToBuf };
