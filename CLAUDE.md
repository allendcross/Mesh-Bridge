# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Mesh Bridge GUI** is a web-based Meshtastic radio relay station and communication gateway. It bridges 1+ Meshtastic radios (2+ for message forwarding) with AI assistant, email/Discord notifications, command system, emergency SOS tracking, and weather alerts.

**Architecture**: Split between Node.js bridge server and React PWA frontend communicating via WebSocket.

## Commands

### Development
```bash
npm install                # Install dependencies
npm run start              # Start both bridge server (8080) + dev server (5173)
npm run dev                # Run Vite dev server only (5173)
npm run bridge             # Run bridge server only (8080, LAN accessible)
```

### Building & Production
```bash
npm run build              # Build production frontend to dist/
npm run production         # Build + run production mode (port 8080)
npm run preview            # Preview production build
```

### Testing
No automated tests currently. Test manually via UI and radio interactions.

### Service Management (Linux systemd)
```bash
sudo ./install-service.sh              # Install systemd service
sudo systemctl start mesh-bridge       # Start service
sudo systemctl stop mesh-bridge        # Stop service
sudo systemctl restart mesh-bridge     # Restart service
sudo systemctl status mesh-bridge      # Check status
sudo journalctl -u mesh-bridge -f      # View live logs
sudo ./uninstall-service.sh            # Uninstall service
```

### Utilities
```bash
npm run cleanup-ports      # Kill processes on port 8080
```

## High-Level Architecture

### Two-Server Architecture

**Development Mode:**
- **Vite Dev Server** (port 5173): Frontend with hot-reload, proxies WebSocket to bridge
- **Bridge Server** (port 8080): Node.js WebSocket server handling radio communication

**Production Mode / Service:**
- **Single Server** (port 8080): Serves static frontend from `dist/` + WebSocket on same port

### Communication Flow

```
Browser (React PWA)
    ↕ WebSocket
Bridge Server (Node.js)
    ↕ Serial USB
Meshtastic Radios
```

**Key Pattern**: All radio communication goes through the bridge server. Frontend NEVER talks to radios directly. This enables:
- Service mode (radios stay connected when browser closed)
- LAN access from multiple devices
- Centralized message deduplication and forwarding logic

### Core Components

#### Bridge Server (`bridge-server/index.mjs`)

**Key Responsibilities:**
- Manages serial connections to Meshtastic radios via `@meshtastic/transport-node-serial`
- Uses `@meshtastic/core` MeshDevice for protocol handling
- Handles message forwarding between radios with smart PSK-based channel matching
- Implements command system (`#ping`, `#weather`, `#ai`, etc.)
- Provides AI assistant integration (Ollama), email (SMTP), Discord (webhooks), MQTT
- Emergency SOS detection and auto-response
- NWS weather alert fetching and broadcasting
- Broadcasts state changes to all WebSocket clients

**Configuration Variables** (lines 54-149):
- `enableSmartMatching`: Smart PSK matching vs index-based forwarding (default: true)
- `commandsEnabled`, `commandPrefix`: Command system configuration
- `aiEnabled`, `aiModel`, `aiEndpoint`: AI assistant (Ollama) config
- `emailEnabled`, `emailHost`, `emailUser`: SMTP email config
- `discordEnabled`, `discordWebhook`: Discord webhook config
- `mqttEnabled`, `mqttBrokerUrl`: MQTT bridge config

**Important**: Radio configuration via `device.configure()` takes 10-30 seconds - this is normal!

#### Protocol Abstraction (`bridge-server/protocols/`)

**Design Pattern**: Multi-protocol support framework (currently Meshtastic-only)

- `BaseProtocol.mjs`: Abstract base class defining protocol interface
- `MeshtasticProtocol.mjs`: Meshtastic implementation using official @meshtastic libraries
- `index.mjs`: Factory for creating protocol instances

**Why this exists**: Originally designed for multiple protocols (Reticulum, RNode, MeshCore). Currently focused on Meshtastic for stability. Architecture allows future protocol additions.

#### Frontend State Management (`src/renderer/store/useStore.ts`)

**Pattern**: Zustand store as single source of truth

- Wraps `WebSocketRadioManager` instance
- Exposes actions and state to all React components
- Event-driven updates from WebSocket manager
- Handles auto-scan, AI config, communication config, MQTT config

**Key State**:
- `radios`: Connected radio status
- `messages`: Message history (persisted to localStorage)
- `nodes`: All mesh nodes seen (persisted to localStorage, 180-day retention)
- `telemetryHistory`: Time-series telemetry per node
- `statistics`: Message counts, rates, per-radio stats
- `logs`: System logs
- `consoleLines`: Raw bridge server console output

#### WebSocket Manager (`src/renderer/lib/webSocketManager.ts`)

**Responsibilities:**
- Maintains WebSocket connection to bridge server
- Handles reconnection with exponential backoff
- Emits events for state changes (radios, messages, stats, logs, nodes)
- Persists messages and nodes to localStorage
- Manages message/node retention (7 days messages, 180 days nodes)

**Smart URL Detection**: Auto-detects bridge server URL (localhost:8080 in dev, current host:8080 in production)

**Important Events**:
- `radio-status-change`: Radio connected/disconnected
- `message-received`: New message from mesh
- `statistics-update`: Stats update
- `log-message`: New log entry
- `console-update`: Raw console output from bridge
- `node-update`: New/updated mesh node
- `telemetry-update`: New telemetry snapshot

### Message Forwarding Logic

**Smart PSK Matching** (`enableSmartMatching = true`, recommended):
1. Message received on Radio A, channel X (PSK: "abc123", name: "Private")
2. Bridge searches ALL channels on Radio B for matching PSK + name
3. If found on channel Y, forwards to channel Y (even if X ≠ Y)
4. Handles cross-index forwarding automatically

**Deduplication**:
- Bridge tracks `seenMessageIds` set (last 1000 messages)
- Frontend also deduplicates by message ID
- Prevents forwarding loops and duplicate display

**Loop Prevention**:
- Bridge tracks messages it sent via `ownNodeNums` set
- Never forwards messages from own radios back to themselves

**Channel Matching Example**:
- Radio A: ch0="LongFast" (AQ==), ch3="Private" (256-bit xyz)
- Radio B: ch3="LongFast" (AQ==), ch0="Private" (256-bit xyz)
- Message on Radio A ch0 → Auto-forwards to Radio B ch3 ✅
- Message on Radio A ch3 → Auto-forwards to Radio B ch0 ✅

### Command System

**Trigger**: Messages starting with `#` (configurable via `commandPrefix`)

**Flow**:
1. Message received with command prefix
2. Bridge parses command and arguments
3. Command executed (weather API, AI query, email send, etc.)
4. Response sent back to originating node/channel
5. Original message NOT forwarded (consumed by bridge)

**Rate Limiting**:
- General commands: 10/minute per user
- AI queries: 3/minute per user (separate limit)

**Commands**: ping, help, status, time, uptime, version, weather, radios, channels, stats, nodes, ai, ask, email, discord, notify

### AI Assistant Integration

**Tech**: Local LLM via Ollama API (`http://localhost:11434`)

**Flow**:
1. User sends `#ai [question]` or `#ask [question]`
2. Bridge checks AI enabled, rate limit, Ollama status
3. Sends prompt to Ollama with system prompt emphasizing brevity
4. Truncates response to ~200 chars (Meshtastic limit)
5. Returns response to user's radio

**System Prompt**: Forces concise responses under 200 characters for mesh compatibility

**Recommended Models**: `llama3.2:1b` (fast, 700MB), `phi3:mini` (excellent, 2.2GB), `llama3.2:3b` (very good, 2GB)

### Emergency Response System

**SOS Detection**: Auto-detects keywords in messages (`#sos`, `#emergency`, `#help`, `#911`, `mayday`, etc.)

**Auto-Response**: When SOS detected:
1. Creates emergency event with timestamp, node, location (if GPS available)
2. Sends automatic response requesting GPS location and battery status
3. Provides reassurance and instructions
4. Broadcasts to UI with audio alert

**NWS Weather Alerts**:
- Fetches alerts from National Weather Service API by state or GPS coordinates
- Auto-broadcasts severe/extreme alerts to mesh network
- Configurable monitoring interval (default: 5 minutes)
- Severity-based filtering (Extreme, Severe, Moderate, Minor)

### Data Persistence

**localStorage Keys**:
- `mesh-bridge-messages`: Message history (7-day retention)
- `mesh-bridge-nodes`: Node database (180-day retention)
- `bridge-server-url`: User-configured bridge URL

**Server-Side Persistence**:
- `bridge-server/bridge-config.json`: AI, email, Discord, MQTT configuration

**Retention Strategy**:
- Messages: Keep last 500 in memory, 7 days in localStorage
- Nodes: Keep all in memory, 180 days in localStorage
- Telemetry: Keep 100 snapshots per node in memory

## Key Technical Decisions

### Why WebSocket Instead of Web Serial API?

**Reason**: Enable service mode and multi-device access

- Web Serial API requires browser to be open with permissions granted
- WebSocket + Node.js bridge allows:
  - Radios stay connected as system service
  - Multiple devices access same bridge simultaneously
  - LAN access from phones/tablets
  - Background operation without browser

### Why Zustand for State Management?

**Reason**: Lightweight, no boilerplate, excellent TypeScript support

- Simpler than Redux for this use case
- No context providers needed
- Direct store access from components
- Easy to test and reason about

### Why Smart PSK Matching?

**Reason**: Handle radios with different channel configurations

- Users often have channels on different indices
- Index-based forwarding breaks with mixed configs
- PSK+name matching enables true cross-mesh bridging
- Supports private channels with matching encryption keys

### Why Separate Protocol Abstraction Layer?

**Reason**: Future-proofing for multi-protocol support

- Currently Meshtastic-only for stability
- Architecture designed to support Reticulum, RNode, MeshCore, etc.
- BaseProtocol defines interface: connect(), disconnect(), sendMessage(), getChannels()
- Easy to add new protocols by extending BaseProtocol

## Common Development Tasks

### Adding a New Command

1. Add command name to `enabledCommands` array in `bridge-server/index.mjs`
2. Add handler in `handleCommand()` method (search for `case 'ping':`)
3. Implement command logic (may involve API calls, file reads, etc.)
4. Return response string (keep under 200 chars for radio display)
5. Add to help text in `case 'help':` handler

### Adding a New UI Component

1. Create component in `src/renderer/components/[ComponentName].tsx`
2. Add route in `src/renderer/components/navigation/tabRoutes.tsx`
3. Add navigation item in `src/renderer/components/navigation/config.ts`
4. Access state via `useStore()` hook
5. Use Tailwind CSS for styling (consistent with existing components)

### Modifying Message Forwarding Logic

**Location**: `bridge-server/index.mjs` in `handleMeshtasticMessage()` method

**Key Areas**:
- Line ~370: Channel matching logic (`findMatchingChannel()`)
- Line ~400: Loop prevention (`ownNodeNums.has()`)
- Line ~420: Deduplication (`seenMessageIds.has()`)
- Line ~450: Message forwarding (`targetDevice.sendText()`)

**Testing**: Connect 2+ radios, send message on one, verify forwarding to matching channels on others

### Adding New Protocol Support

1. Create `bridge-server/protocols/[ProtocolName]Protocol.mjs`
2. Extend `BaseProtocol` class
3. Implement required methods: `connect()`, `disconnect()`, `sendMessage()`, `getChannels()`
4. Emit events: `message`, `node-update`, `telemetry`, `error`, `status-change`
5. Add protocol to `bridge-server/protocols/index.mjs` registry
6. Update `RadioProtocol` type in `src/renderer/types.ts`

### Debugging WebSocket Communication

**Bridge Server Logs**: Run `npm run bridge` in terminal, watch console output

**Browser DevTools**: Network tab → WS → Click connection → Messages tab

**Console Capture**: UI "Logs" tab shows raw bridge server console output in real-time

**Tip**: Enable verbose logging by adding `console.log()` statements in bridge server

## Important File Locations

- **Bridge Entry Point**: `bridge-server/index.mjs`
- **Protocol Handlers**: `bridge-server/protocols/`
- **Frontend Entry**: `src/renderer/main.tsx`
- **App Component**: `src/renderer/App.tsx`
- **State Store**: `src/renderer/store/useStore.ts`
- **WebSocket Manager**: `src/renderer/lib/webSocketManager.ts`
- **Type Definitions**: `src/renderer/types.ts`
- **Config File**: `bridge-server/bridge-config.json` (auto-generated)
- **Service Template**: `mesh-bridge.service`
- **Service Install**: `install-service.sh`, `scripts/install-service.sh`

## Environment & Dependencies

**Node.js**: 18+ required for bridge server
**Browsers**: Modern browsers (Chrome, Firefox, Edge, Safari)
**Hardware**: Meshtastic devices connected via USB
**Optional**: Ollama for AI assistant, SMTP for email, Discord webhook for notifications

**Key Dependencies**:
- `@meshtastic/core`: Official Meshtastic protocol library
- `@meshtastic/transport-node-serial`: Serial port transport
- `ws`: WebSocket server
- `serialport`: USB serial communication
- `nodemailer`: Email sending (SMTP)
- `mqtt`: MQTT client
- `react`, `react-dom`: UI framework
- `zustand`: State management
- `leaflet`, `react-leaflet`: Interactive maps
- `recharts`: Charts and graphs
- `tailwindcss`: Styling

## Known Issues & Limitations

- Radio configuration takes 10-30 seconds (normal - `device.configure()` is slow)
- Serial/USB radios only (no BLE or network radios yet)
- Service installation Linux-only (Windows/macOS service support planned)
- Alpha software - expect bugs and breaking changes
- Limited to ~200 char responses due to Meshtastic message limits

## Troubleshooting Tips

**Radios won't connect**: Check USB connections, close other serial programs, add user to `dialout` group on Linux

**Messages not forwarding**: Verify channels have matching PSK+name on both radios, check bridge logs for channel mismatch warnings

**Port 8080 in use**: Run `npm run cleanup-ports` or `lsof -ti:8080 | xargs kill -9`

**AI not working**: Start Ollama with `ollama serve`, verify model installed with `ollama list`

**Email/Discord failing**: Check credentials, test SMTP/webhook separately, review bridge console for error details

## Project Status

**Maturity**: Alpha (version 0.25.11)

**Production Ready**: Core bridging functionality stable, UI/UX may have issues

**Recommended For**: Testing, home mesh networks, single radio with AI/notifications, emergency response, weather monitoring

**Use with Caution**: Critical infrastructure, high-reliability requirements

## Development Workflow

1. Make changes to frontend: Hot-reload at `http://localhost:5173`
2. Make changes to bridge server: Restart `npm run bridge`
3. Test with real radios connected via USB
4. Build for production: `npm run build`
5. Test production mode: `npm run production`
6. Install as service: `sudo ./install-service.sh`
7. Monitor service: `sudo journalctl -u mesh-bridge -f`

## Architecture Patterns to Maintain

**Event-Driven Communication**: Bridge server emits events, WebSocket manager listens, store updates UI
**Single Source of Truth**: Zustand store holds all state, components read via hooks
**Protocol Abstraction**: All protocol-specific logic in protocol classes, bridge server protocol-agnostic
**Persistence Strategy**: Short-term in memory, medium-term in localStorage, long-term in config files
**Configuration via Code**: Bridge server config in `index.mjs`, can be moved to UI in future
**Service-First Design**: Assume bridge runs as always-on service, not just when browser open
