# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GameCenter is a Vue 3 + TypeScript peer-to-peer multiplayer game platform. Players can create lobbies and play directly without dedicated servers, using WebRTC/PeerJS for real-time communication. The architecture supports host migration, network recovery, and optimistic UI updates.

## Development Commands

### Core Development
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production (includes type checking)
- `npm run preview` - Preview production build locally

### Code Quality
- `npm run lint` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier
- `npm run type-check` - TypeScript type checking

### Testing
- `npm run test:unit` - Run Vitest unit tests
- `npm run test:e2e` - Run Playwright E2E tests
- `npm run test:e2e -- --project=single-monitor` - Run E2E tests in single-monitor mode
- `npx playwright install` - Install browsers for first E2E test run

## Architecture

### State Management (Pinia + Persistence)
- **gameStore.ts**: Main game state with peer-to-peer sync, host migration, and optimistic updates
- **persistedState.ts**: Custom persistence plugin with TTL support and safe storage handling
- **hostMigration.ts**: Dedicated host migration logic with consensus voting

### Peer-to-Peer Communication
- **peerService.ts**: WebRTC connection management and message routing
- **peerService.mock.ts**: Mock implementation for testing
- **peerSelector.ts**: Runtime service selection (real vs mock)

### Game Flow
1. **MainMenu**: Create or join rooms
2. **Lobby**: Player management, game setup
3. **GameField**: Game phases with synchronized state

### Message System
All peer communication uses strongly-typed messages defined in `types/game.ts`:
- Versioned state synchronization with snapshots and diffs
- Optimistic UI with delivery confirmation
- Host migration with consensus voting
- Network recovery and split-brain resolution

### Key Files
- `src/types/game.ts`: Complete type definitions for game state, messages, and protocol
- `src/stores/gameStore.ts`: Core game logic with mutex-protected critical sections
- `src/components/GameField.vue`: Main game interface with phase management
- `memory-bank/`: Context documentation (product goals, architecture notes)

## Testing Strategy

### E2E Tests (Playwright)
- Multi-client scenarios with shared browser contexts
- Single-monitor and multi-monitor test configurations
- Async game flow testing with 4-player scenarios
- Mock peer service integration for isolated testing

### Unit Tests (Vitest)
- Store persistence and state management
- Utility functions and safe storage handling
- Game logic validation

## Key Patterns

### Optimistic Updates
Actions show immediate feedback with rollback on failure. Use mutexes for critical sections (voting, betting).

### Host Migration
Automatic consensus-based host selection when current host disconnects. All players participate in voting with token verification.

### State Versioning
Incremental state updates with version tracking to handle network partitions and ensure consistency.

### Safe Storage
Use `storageSafe.ts` utilities for localStorage operations with error handling and TTL support.

## Development Notes

- Vue 3 Composition API with `<script setup>` syntax
- TypeScript strict mode enabled
- ESLint configured with unused imports detection
- Responsive design with mobile viewport support
- E2E tests support both single and multi-monitor setups