import { MQTT_CMD_TOPIC } from '@/settings';
import { VirtualRemoteCommand } from '@/types';
import { Logger } from 'homebridge';
import mqtt, { IConnackPacket, MqttClient } from 'mqtt';

interface MqttApiOptions {
  ip: string;
  port: number;
  username?: string;
  password?: string;
  verboseLogging?: boolean;
  logger: Logger;
}

export class MqttApi {
  private readonly client: MqttClient;
  private readonly logger: Logger;
  private readonly verboseLogging: boolean;

  constructor(options: MqttApiOptions) {
    this.client = mqtt.connect({
      host: options.ip,
      port: options.port,
      username: options.username,
      password: options.password,
      reconnectPeriod: 10_000,
    });

    this.client.on('connect', this.handleConnect.bind(this));
    this.client.on('error', this.handleError.bind(this));

    this.logger = options.logger;
    this.verboseLogging = options.verboseLogging ?? false;
  }

  private log(...args: unknown[]): void {
    if (!this.verboseLogging) return;
    this.logger.debug('[MQTT]', ...args);
  }

  subscribe(topic: string | string[]): void {
    this.client.subscribe(topic);
  }

  on(event: 'message', listener: (topic: string, payload: Buffer) => void): void {
    this.client.on(event, listener);
  }

  isConnected(): boolean {
    return this.client.connected;
  }

  end(): void {
    this.client.end();
  }

  setSpeed(speed: number): void {
    const payload = JSON.stringify({ speed: `${speed}` });
    this.log('CMD speed:', payload);
    this.client.publish(MQTT_CMD_TOPIC, payload);
  }

  setVirtualRemoteCommand(command: VirtualRemoteCommand): void {
    const payload = JSON.stringify({ vremote: `${command}` });
    this.log('CMD vremote:', payload);
    this.client.publish(MQTT_CMD_TOPIC, payload);
  }

  private handleConnect(packet: IConnackPacket): void {
    this.log('Connected', JSON.stringify(packet));
  }

  private handleError(error: Error): void {
    this.logger.error('[MQTT] Error:', error.message);
  }
}
