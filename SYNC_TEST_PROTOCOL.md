# StreamSync Real-Device Sync Test Protocol

## Setup
1. Two physical devices — both open: https://streamconnectroshni.duckdns.org?diag=1
2. Device A creates a room and starts playing a movie from the beginning
3. Device B joins the room using the share link

## What to check at T+30 seconds
- Both HUDs should show "Zone: LOCK" with drift under 150ms
- If iOS HLS: YES on both devices, drift under 800ms is acceptable
- If one shows SEEK repeatedly, NTP offset is wrong — tap FORCE RESYNC

## What to check at T+2 minutes  
- Drift should not exceed 2000ms on any device
- If drift is growing consistently (not spiking and recovering), 
  the NTP offset is wrong — its sign is likely inverted

## Common failure patterns
- Drift grows 3s → 4s → 6s: NTP calibrated in background tab — tap FORCE RESYNC
- Drift is fixed at ~30s: sync.started anchor is wrong — rejoin the room
- Drift oscillates ±1s: slewing working but overshoot — normal, will stabilize

## Pass criteria
- T+5m: drift under 1000ms on iOS+iOS
- T+10m: drift under 2000ms on iOS+iOS with no permanent divergence
