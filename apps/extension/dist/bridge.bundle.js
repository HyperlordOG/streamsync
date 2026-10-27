(() => {
  // ../../packages/injectors/src/bridge/index.js
  var BRIDGE_CHANNELS = {
    COMMAND: "STREAMSYNC_MAIN_COMMAND",
    EVENT: "STREAMSYNC_MAIN_EVENT"
  };
  function installMainWorldBridge() {
    if (typeof window === "undefined") return;
    if (window.__STREAMSYNC_BRIDGE_INSTALLED__) return;
    window.__STREAMSYNC_BRIDGE_INSTALLED__ = true;
    function getNetflixPlayer() {
      try {
        const netflix = window.netflix;
        const api = netflix?.appContext?.state?.playerApp?.getAPI?.();
        const videoPlayer = api?.videoPlayer;
        if (!videoPlayer) return null;
        const ids = videoPlayer.getAllPlayerSessionIds ? videoPlayer.getAllPlayerSessionIds() : [];
        const watchId = ids.find((id) => typeof id === "string" && id.startsWith("watch-")) || ids[ids.length - 1] || ids[0];
        return watchId ? videoPlayer.getVideoPlayerBySessionId(watchId) : null;
      } catch {
        return null;
      }
    }
    function getActivePlayer() {
      const netflix = getNetflixPlayer();
      if (netflix) return { type: "netflix", player: netflix };
      const yt = document.getElementById("movie_player");
      if (yt && typeof yt.playVideo === "function") return { type: "youtube", player: yt };
      const video = document.querySelector(".webPlayerContainer video") || document.querySelector(".rendererContainer video") || document.querySelector("#dv-web-player video") || document.querySelector("video");
      if (video) return { type: "html5", player: video };
      return null;
    }
    window.addEventListener(BRIDGE_CHANNELS.COMMAND, async (event) => {
      const { action, payload, id } = event.detail || {};
      const target = getActivePlayer();
      let response = { id, success: false };
      if (!target) {
        window.dispatchEvent(new CustomEvent(BRIDGE_CHANNELS.EVENT, { detail: { ...response, error: "NO_PLAYER" } }));
        return;
      }
      try {
        const { type, player } = target;
        switch (action) {
          case "play":
            if (type === "netflix") await player.play();
            else if (type === "youtube") player.playVideo();
            else await player.play();
            response.success = true;
            break;
          case "pause":
            if (type === "netflix") await player.pause();
            else if (type === "youtube") player.pauseVideo();
            else player.pause();
            response.success = true;
            break;
          case "seek": {
            const sec = Number(payload?.seconds || 0);
            if (type === "netflix") await player.seek(Math.round(sec * 1e3));
            else if (type === "youtube") player.seekTo(sec, true);
            else player.currentTime = sec;
            response.success = true;
            break;
          }
          case "rate": {
            const rate = Number(payload?.rate || 1);
            if (type === "netflix" && typeof player.setPlaybackRate === "function") {
              try {
                player.setPlaybackRate(rate);
              } catch {
              }
            }
            if (type === "youtube" && typeof player.setPlaybackRate === "function") {
              player.setPlaybackRate(rate);
            }
            const v = document.querySelector("video");
            if (v) v.playbackRate = rate;
            response.success = true;
            break;
          }
          case "get_state": {
            let currentTime = 0;
            let duration = 0;
            let paused = true;
            let buffering = false;
            let playbackRate = 1;
            if (type === "netflix") {
              currentTime = (player.getCurrentTime?.() || 0) / 1e3;
              duration = (player.getDuration?.() || 0) / 1e3;
              paused = player.isPaused?.() ?? true;
              buffering = !!player.getBusy?.()?.buffering;
            } else if (type === "youtube") {
              currentTime = player.getCurrentTime?.() || 0;
              duration = player.getDuration?.() || 0;
              const s = player.getPlayerState?.();
              paused = s !== 1 && s !== 3;
              buffering = s === 3;
              playbackRate = player.getPlaybackRate?.() || 1;
            } else {
              currentTime = player.currentTime || 0;
              duration = player.duration || 0;
              paused = player.paused;
              buffering = player.seeking || player.readyState === 0;
              playbackRate = player.playbackRate || 1;
            }
            response = {
              id,
              success: true,
              data: { currentTime, duration, paused, buffering, playbackRate, provider: type }
            };
            break;
          }
        }
      } catch (err) {
        response.error = err.message;
      }
      window.dispatchEvent(new CustomEvent(BRIDGE_CHANNELS.EVENT, { detail: response }));
    });
    console.log("[StreamSync Bridge] Main World Bridge active");
  }

  // src/bridge/inject.js
  installMainWorldBridge();
})();
