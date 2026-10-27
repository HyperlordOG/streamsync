/**
 * @streamsync/sync-engine
 * 
 * Production NTP Virtual Timeline and Dual-Threshold Drift Correction Engine
 * Reverse engineered from Hearo architecture for ultra-low latency watch party sync.
 */

export { ClockSynchronizer } from './clock.js';
export { VirtualTimeline } from './timeline.js';
export { DriftEngine, DriftState } from './drift.js';
export { BasePlayerAdapter } from './adapter/base.js';
export { HTML5VideoAdapter } from './adapter/html5.js';
export { MockPlayerAdapter } from './adapter/mock.js';
export { SyncClient } from './client.js';
