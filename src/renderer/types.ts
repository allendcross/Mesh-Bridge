// Radio protocol types
export type RadioProtocol = 'meshtastic' | 'bluetooth';

export interface Radio {
  id: string;
  port: string;
  name: string;
  protocol: RadioProtocol;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  nodeInfo?: {
    nodeId: string;
    longName: string;
    shortName: string;
    hwModel: string;
  };
  lastSeen?: Date;
  signalStrength?: number;
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
  // Channel configurations
  channels?: Channel[];
  // Protocol-specific metadata
  protocolMetadata?: {
    // Meshtastic-specific
    firmware?: string;
    hardware?: string;
    deviceTime?: Date;  // Current radio time
    deviceTimeSource?: 'gps' | 'telemetry' | 'message' | null;  // Source of device time
    loraConfig?: {
      region?: string;
      modemPreset?: string;
      hopLimit?: number;
      txEnabled?: boolean;
      txPower?: number;
      channelNum?: number;
      overrideDutyCycle?: boolean;
      sx126xRxBoostedGain?: boolean;
      overrideFrequency?: number;
      paFanDisabled?: boolean;
    };
  };
}

export interface BridgeConfig {
  enabled: boolean;
  bridges: BridgeRoute[];
  deduplicationWindow: number;
  autoReconnect: boolean;
  reconnectDelay: number;
  maxReconnectAttempts: number;

  // Advanced forwarding options
  forwardNodeInfo?: boolean;          // Forward node announcements across bridge
  forwardEncryptedByIndex?: boolean;  // Forward encrypted messages by channel index instead of PSK matching
}

export interface BridgeRoute {
  id: string;
  sourceRadios: string[];
  targetRadios: string[];
  enabled: boolean;
}

export interface Message {
  id: string;
  timestamp: Date;
  fromRadio: string;
  toRadio?: string;
  protocol: RadioProtocol;
  from: number | string;
  to: number | string;
  channel: number;
  portnum: number;
  payload: any;
  text?: string; // Decoded text message content
  forwarded: boolean;
  duplicate: boolean;
  sent?: boolean; // True if this message was sent by us (not received)
  rssi?: number;
  snr?: number;
  hopLimit?: number;
}

export interface Statistics {
  uptime: number;
  totalMessagesReceived: number;
  totalMessagesForwarded: number;
  totalMessagesDuplicate: number;
  totalErrors: number;
  messageRatePerMinute: number;
  radioStats: {
    [radioId: string]: {
      received: number;
      sent: number;
      errors: number;
    };
  };
}

export interface MeshNode {
  nodeId: string;
  num: number;
  longName: string;
  shortName: string;
  hwModel: string;
  lastHeard: Date;
  snr?: number;
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
    time?: Date;
  };
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  fromRadio: string; // Which radio saw this node
}

// ADS-B aircraft contact (normalized from dump1090 / airplanes.live by the bridge).
// Field names are chosen to map cleanly to CoT for future TAK export.
export interface Aircraft {
  icao: string;            // ICAO24 hex address (unique id)
  callsign?: string;       // flight / call sign (trimmed)
  lat: number;
  lon: number;
  altFt?: number;          // barometric altitude, feet
  track?: number;          // heading, degrees (0-359) — used for marker rotation
  groundSpeedKt?: number;  // ground speed, knots
  verticalRateFpm?: number;
  squawk?: string;         // Mode A squawk code
  category?: string;       // emitter category (A1=light .. A7)
  rssi?: number;           // signal (local receiver only), dBFS
  seenPos?: number;        // seconds since last position — drives fade/expiry
  seen?: number;           // seconds since last message of any kind
  emergency?: boolean;     // squawk is 7500/7600/7700
}

// Server/relay location used to auto-center the Tactical map.
export interface StationLocation {
  lat: number;
  lon: number;
  source: 'config' | 'ip';
  label?: string;
}

export interface TelemetrySnapshot {
  timestamp: Date;
  nodeId: string;
  batteryLevel?: number;
  voltage?: number;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  snr?: number;
  channelUtilization?: number;
  airUtilTx?: number;
}

export interface NodeTelemetryHistory {
  nodeId: string;
  snapshots: TelemetrySnapshot[];
}

export interface LogEntry {
  id?: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug' | 'time-sync';
  message: string;
  context?: string;
  radioId?: string;
  data?: any;
  error?: string;
}

export interface AIConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  maxTokens: number;
  maxResponseLength: number;
  timeout: number;
  rateLimit: number;
  systemPrompt: string;
}

export interface AIModel {
  name: string;
  size: number;
  digest?: string;
  modified_at?: string;
}

export interface AIStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export interface AIModelPullProgress {
  model: string;
  status: string;
  completed?: number;
  total?: number;
}

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  from: string;
  to: string;
  subjectPrefix: string;
}

export interface DiscordConfig {
  enabled: boolean;
  webhook: string;
  username: string;
  avatarUrl: string;
  botEnabled: boolean;
  botToken: string;
  channelId: string;
  sendEmergency: boolean;
}

export interface MQTTConfig {
  enabled: boolean;
  brokerUrl: string;
  username: string;
  password: string;
  topicPrefix: string;
  qos: number;
  retain: boolean;
  connected?: boolean;
}

export interface AdvertisementBotConfig {
  enabled: boolean;
  interval: number;  // milliseconds between advertisements
  messages: string[];  // array of messages to rotate through
  targetRadios: string[];  // radioIds to send from, empty = all radios
  channel: number;  // 0-7, default 0 (public channel)
}

export interface CommunicationConfig {
  email: EmailConfig;
  discord: DiscordConfig;
}

// Web Serial API Type Extensions
declare global {
  interface Navigator {
    serial: Serial;
  }

  interface Serial extends EventTarget {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }

  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
  }

  interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
  }

  interface SerialPort extends EventTarget {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    getInfo(): SerialPortInfo;
  }

  interface SerialOptions {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
  }

  interface SerialPortInfo {
    usbVendorId?: number;
    usbProductId?: number;
  }
}

// Meshtastic Channel Configuration Types
export type ChannelRole = 'PRIMARY' | 'SECONDARY' | 'DISABLED';

export interface ChannelSettings {
  psk?: Uint8Array | string;  // Pre-shared key for encryption (Uint8Array or base64 string)
  name?: string;  // Channel name
  id?: number;  // Channel number/ID
  uplinkEnabled?: boolean;
  downlinkEnabled?: boolean;
  moduleSettings?: {
    positionPrecision?: number;
  };
}

export interface Channel {
  index: number;  // Channel index (0-7)
  settings: ChannelSettings;
  role: ChannelRole;
}

export interface ChannelConfig {
  index: number;
  settings: ChannelSettings;
  role: ChannelRole;
}
