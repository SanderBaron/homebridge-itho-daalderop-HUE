import fs from 'node:fs';
import { Logger } from 'homebridge';

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // rotate to .old above 50 MB (~ several days of data)
const SIZE_CHECK_EVERY = 200; // stat() the file once per N rows, not on every append
const CSV_HEADER = 'timestamp,duct_hum,indoor_hum,speed_pct,cve_state,mirror_state,toilet_state,event\n';

export interface DataLogRow {
  ductHum?: number | null;
  indoorHum?: number | null;
  speedPct?: number | null;
  cveState: string;
  mirrorState?: string;
  toiletState?: string;
  /** Optional marker(s), e.g. 'cve:idle->boosting' on a state transition */
  event?: string;
}

/**
 * Appends one CSV row per MQTT status update so threshold/rise settings can be
 * tuned on real data afterwards. Best-effort: write errors never disrupt the
 * automations, they are only logged at debug level.
 */
export class HumidityDataLogger {
  private rowsSinceSizeCheck = 0;
  private warned = false;
  private headerChecked = false;

  constructor(
    private readonly filePath: string,
    private readonly log: Logger,
  ) {}

  append(row: DataLogRow): void {
    try {
      this.rotateIfNeeded();
      this.rotateOnHeaderChange();
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, CSV_HEADER);
      }
      const line = [
        new Date().toISOString(),
        row.ductHum ?? '',
        row.indoorHum ?? '',
        row.speedPct ?? '',
        row.cveState,
        row.mirrorState ?? '',
        row.toiletState ?? '',
        row.event ?? '',
      ].join(',') + '\n';
      fs.appendFileSync(this.filePath, line);
      this.warned = false;
    } catch (err: unknown) {
      if (!this.warned) {
        this.warned = true;
        this.log.warn(
          `[DataLog] Schrijven naar ${this.filePath} mislukt: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * When the column layout changed since the file was written (older plugin
   * version), move the old file aside once so the CSV stays consistent.
   */
  private rotateOnHeaderChange(): void {
    if (this.headerChecked) return;
    this.headerChecked = true;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.alloc(CSV_HEADER.length + 64);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString('utf8', 0, bytes).split('\n')[0] + '\n';
      if (firstLine !== CSV_HEADER) {
        const archive = this.filePath.replace(/\.csv$/, `-${new Date().toISOString().slice(0, 10)}.csv`);
        fs.renameSync(this.filePath, archive);
        this.log.info(`[DataLog] Kolomindeling gewijzigd — oude log bewaard als ${archive}`);
      }
    } catch {
      // file does not exist yet — nothing to migrate
    }
  }

  private rotateIfNeeded(): void {
    if (++this.rowsSinceSizeCheck < SIZE_CHECK_EVERY) return;
    this.rowsSinceSizeCheck = 0;
    try {
      if (fs.statSync(this.filePath).size > MAX_SIZE_BYTES) {
        fs.renameSync(this.filePath, `${this.filePath}.old`);
        this.log.info(`[DataLog] Logbestand geroteerd naar ${this.filePath}.old`);
      }
    } catch {
      // file does not exist yet — nothing to rotate
    }
  }
}
