/**
 * StreamSync - Extension Toolbar Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const btnCreate = document.getElementById('btn-create-party');
  const btnJoin = document.getElementById('btn-join-party');
  const inputHostName = document.getElementById('input-host-name');
  const inputRoomCode = document.getElementById('input-room-code');
  const inputGuestName = document.getElementById('input-guest-name');
  const detectedService = document.getElementById('detected-service');
  const cardCreate = document.getElementById('card-create');
  const cardJoin = document.getElementById('card-join');
  const cardActive = document.getElementById('card-active');
  const activeCode = document.getElementById('active-code');
  const btnCopyActiveLink = document.getElementById('btn-copy-active-link');

  // Query active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Query status from content script
  chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      detectedService.textContent = 'Service: Open a video to start';
      return;
    }

    if (res.provider) {
      detectedService.textContent = `Provider: ${res.provider.toUpperCase()}`;
    }

    if (res.connected && res.room?.shortId) {
      cardCreate.style.display = 'none';
      cardJoin.style.display = 'none';
      cardActive.style.display = 'flex';
      activeCode.textContent = res.room.shortId;

      btnCopyActiveLink.onclick = () => {
        const link = `http://localhost:3001/party/${res.room.shortId}`;
        navigator.clipboard.writeText(link);
        btnCopyActiveLink.textContent = 'Copied!';
        setTimeout(() => { btnCopyActiveLink.textContent = 'Copy Invite Link'; }, 1500);
      };
    }
  });

  // Create Party
  btnCreate.addEventListener('click', () => {
    btnCreate.disabled = true;
    btnCreate.textContent = 'Creating...';

    chrome.tabs.sendMessage(tab.id, {
      action: 'CREATE_PARTY',
      displayName: inputHostName.value.trim() || 'Host',
    }, (res) => {
      btnCreate.disabled = false;
      btnCreate.textContent = 'Create Watch Party';

      if (chrome.runtime.lastError) {
        alert('Could not connect to video player. Please refresh this streaming tab and try again.');
        return;
      }

      if (res?.error) {
        alert(`Error: ${res.error}`);
      } else {
        window.close(); // Close popup and let user see floating overlay
      }
    });
  });

  // Join Party
  btnJoin.addEventListener('click', () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    if (!code || code.length < 4) {
      alert('Please enter a valid 6-character room code');
      return;
    }

    btnJoin.disabled = true;
    btnJoin.textContent = 'Joining...';

    chrome.tabs.sendMessage(tab.id, {
      action: 'JOIN_PARTY',
      code,
      displayName: inputGuestName.value.trim() || 'Guest',
    }, (res) => {
      btnJoin.disabled = false;
      btnJoin.textContent = 'Join Party';

      if (chrome.runtime.lastError) {
        alert('Could not connect to video player. Please refresh this streaming tab and try again.');
        return;
      }

      if (res?.error) {
        alert(`Error: ${res.error}`);
      } else {
        window.close();
      }
    });
  });
});
