// MFRC522 Node.js Treiber
// Orientiert an pi-rc522 (Python) von ondryaso
// Angepasst für: Clone-Module, langes Kabel, HAOS ohne RPi.GPIO
//
// Reader-Recovery ist bei günstigen RC522-Boards wichtig.
// Im Normalpfad bleiben wir bei request(WUPA) → anticoll → UID lesen.
// Zusätzliche Resets nur gezielt bei echten Hängern.

const spi = require("spi-device");
const { execSync } = require("child_process");

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

  async hardwareReset() {
    try {
      // libgpiod v2 Syntax
      execSync("gpioset -p 10ms -t0 /dev/gpiochip0 25=0", {
        timeout: 3000,
        stdio: "pipe",
      });
      execSync("gpioset -p 50ms -t0 /dev/gpiochip0 25=1", {
        timeout: 3000,
        stdio: "pipe",
      });

      await sleep(50);
      console.log("RC522: Hardware-Reset GPIO 25 OK");