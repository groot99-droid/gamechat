# GameChat

Private, serverless voice / video / screen-share rooms for gaming with friends. No accounts, no cloud.

## Install (Windows)

**One line** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/groot99-droid/gamechat/main/install.ps1 | iex
```

**Or download** from the [latest release](https://github.com/groot99-droid/gamechat/releases/latest):
`GameChat-Setup-*.exe` (installer + shortcut) or `GameChat-Portable-*.exe` (no install).

The app is unsigned: SmartScreen > *More info* > *Run anyway*; allow the firewall prompt (Private and Public).

## Phone (iPhone / Android, nothing to install)

1. On the PC that hosts the room, start the room. The header shows **Phone: https://<pc-ip>:7778**.
2. Open that link in the phone's browser (same Wi-Fi, or Tailscale on the phone).
3. The page uses a self-signed certificate, so accept the warning once (Advanced > Proceed). HTTPS is what lets the browser use the mic.
4. Enter name + room password > Join. Voice, camera, chat, channels and soundboard work; hosting, screen share, clips, overlay and hotkeys are PC-only.

Tip: use "Add to Home Screen" for an app-like icon. Keep the screen on while talking; browsers pause audio when the tab is in the background.

## Use

Host: name + room + password > Start room > copy the invite code to friends. Join: paste the code.
Friends outside your network: use Tailscale. See the in-app Settings for hotkeys, soundboard, clips and overlay.

El Fuego quick-room: the password is not bundled; enter it once and it is remembered.

The full user guide (hosting, channels, hotkeys, voice, soundboard and clips, overlay, Internet mode, troubleshooting, privacy, building from source) is in [README.txt](README.txt), which ships with the app.
