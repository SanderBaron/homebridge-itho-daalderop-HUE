import fs from 'node:fs';
import { Logger } from 'homebridge';

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // rotate to .old above 50 MB (~ several days of data)
const SIZE_CHECK_EVERY = 200; // stat() the file once per N rows, not on every append
const CSV_HEADER = 'timestamp,duct_hum,indoor_hum,speed_pct,cve_state,event\n';

export interface DataLogRow {
  ductHum?: number | null;
  indoorHum?: number | null;
  speedPct?: number | null;
  cveState: string;
  /** Optional marker, e.g. 'cve:idle->boosting' on a state transition */
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

  constructor(
    private readonly filePath: string,
    private readonly log: Logger,
  ) {}

  append(row: DataLogRow): void {
    try {
      this.rotateIfNeeded();
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, CSV_HEADER);
      }
      const line = [
        new Date().toISOString(),
        row.ductHum ?? '',
        row.indoorHum ?? '',
        row.speedPct ?? '',
        row.cveState,
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
