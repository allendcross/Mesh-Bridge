/**
 * Protocol Handler Exports
 *
 * Central export point for all radio protocol handlers
 */

import { BaseProtocol } from './BaseProtocol.mjs';
import { MeshtasticProtocol } from './MeshtasticProtocol.mjs';
// BluetoothProtocol disabled - requires @abandonware/noble which is not available in all environments
// import { BluetoothProtocol } from './BluetoothProtocol.mjs';

// Re-export for convenience
export { BaseProtocol, MeshtasticProtocol };

/**
 * Factory function to create protocol handler
 * @param {string} protocol - Protocol type ('meshtastic', 'bluetooth')
 * @param {string} radioId - Radio ID
 * @param {string} portPath - Serial port path or Bluetooth device address
 * @param {object} options - Protocol options
 * @returns {BaseProtocol} Protocol handler instance
 */
export function createProtocol(protocol, radioId, portPath, options = {}) {
  switch (protocol.toLowerCase()) {
    case 'meshtastic':
      return new MeshtasticProtocol(radioId, portPath, options);

    case 'bluetooth':
      throw new Error(`Bluetooth protocol not available - @abandonware/noble package is not installed`);

    default:
      throw new Error(`Unknown protocol: ${protocol}. Supported protocols: 'meshtastic'`);
  }
}

/**
 * Get list of supported per-radio protocols
 * @returns {Array<string>} Array of supported protocol names
 */
export function getSupportedProtocols() {
  return ['meshtastic'];
}
