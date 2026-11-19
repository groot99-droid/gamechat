GAMECHAT 2.2 - private voice, video & screen share for gaming
==============================================================

No accounts, no cloud. One person hosts a room, everyone else connects straight
to them and to each other.

INSTALL
  Option A (easiest): double-click GameChat-Portable-<version>.exe. Nothing to install.
  Option B: run GameChat-Setup-<version>.exe for a normal install + desktop shortcut.
  Both are on the latest GitHub release; the PowerShell one-liner in README.md
  downloads the newest one for you.
  - Windows SmartScreen may say "protected your PC" because the app is not
    code-signed: click More info > Run anyway.
  - If Windows asks about the firewall, click Allow (tick Private AND Public).

HOSTING
  1. Type your name, pick a room name + password, click Start room.
  2. Click "Copy invite code" at the top and send it privately to friends.
     (The code contains the password. Anyone holding it can join.)

JOINING
  - Paste the invite code in "Invite code", or
  - pick the room from "Rooms on your network" (same Wi-Fi/LAN, found automatically)
    and type the password, or
  - type the host's address + password.
  Rooms you join or host are remembered (passwords are encrypted by Windows).

EL FUEGO (the private party room)
  The lobby has a big fire-themed "El Fuego" panel. The password is NOT bundled:
  type it once in the password box (ask the host); it is then remembered on this PC.
  - Host El Fuego: starts the room (channels Fogata, Squad 1, Squad 2).
  - Join El Fuego: finds the room on your Wi-Fi, or uses the last host you joined.
    If it is not found, paste the host's invite code (or address) and press Join.
  - Quick start: Ctrl+Shift+H from anywhere, even with a game focused. If you are
    the host it starts the room; if you are a friend it joins the host you used
    before (or the El Fuego room on your network); the very first press picks
    "join" if a room is found, otherwise it hosts. Change the key in
    Settings > Hotkeys > "Quick start El Fuego".
  - The whole app glows orange while you are in El Fuego. Other rooms keep the
    normal look.
  Friends outside your house still need Tailscale (or Internet mode): the network path is not built in.

PHONE (iPhone / Android, nothing to install)
  1. On the PC that hosts the room, start the room. The header shows
     "Phone: https://<pc-ip>:7778" (the room port + 1).
  2. Open that link in the phone's browser (same Wi-Fi, or Tailscale on the phone).
  3. The page uses a self-signed certificate: accept the warning once
     (Advanced > Proceed). HTTPS is what lets the browser use the mic.
  4. Enter name + room password > Join. Voice, camera, chat, channels and the
     soundboard work; hosting, screen share, clips, overlay and hotkeys are PC-only.
  Keep the phone screen on while talking; browsers pause audio in background tabs.

CHANNELS
  Rooms have several channels (default: Lobby, Squad 1, Squad 2). Click a channel
  to move; voice only connects people in the same channel. Each channel has its
  own chat, and chat history is saved on the host's PC. The host can add, rename
  and delete channels (hover a channel).

HOTKEYS (work while a game is focused)  -  Settings > Hotkeys
  Defaults: Ctrl+Alt+M mute, +D deafen, +V camera, +S share screen, +C clip,
  +O overlay, +X stop sounds, +G show/hide window, +Down/Up next/previous channel.
  Set your own for everything, including push-to-talk (hold) and one key per
  soundboard sound. Mouse side buttons can be hotkeys too.
  Privacy: only the keys you bind are looked at. Nothing is logged or sent.
  Some antivirus tools dislike any app that listens for global keys; if yours
  complains, allow GameChat or skip hotkeys.

VOICE
  Modes: always on, voice activity (noise gate with live meter), or push-to-talk.
  Mic boost 0-300%, per-person volume up to 300% (hover someone's tile), echo
  cancellation / noise suppression / auto gain.

SOUNDBOARD + CLIPS
  - Soundboard button: click a sound to play it to everyone (Shift+click = only
    you). Add your own mp3/wav/ogg files; 5 built-in sounds included.
  - Clip button (or hotkey): saves the last N seconds (5-60, default 20) of what
    EVERYONE said into your soundboard as a new sound, so you can replay it to the
    room. The rolling buffer lives only in memory until you press Clip, and the
    whole channel sees "X clipped the last 20s" so nobody is recorded in secret.
    Turn the buffer off in Settings > Clips.

OVERLAY
  A transparent, click-through box over your game showing who is talking and clip
  notices. Works in windowed / borderless windowed. Exclusive fullscreen games
  hide it: switch the game to borderless. Settings > Overlay for corner/size.

PLAYING WITH FRIENDS OUTSIDE YOUR HOUSE
  Best: everyone installs Tailscale (free, tailscale.com) and joins the same
  tailnet. The host's invite code will then contain the Tailscale address.
  Optional "Internet mode" (checkbox on host and join, or Settings > Network):
    - Host: asks your router to open the port via UPnP and shows your public
      address in the invite code.
    - Everyone: uses Google's free STUN servers to find a direct path.
    It only works if your router allows UPnP and your ISP gives you a real public
    address (not CGNAT; the app warns you). Tradeoffs: Google learns your public
    IP, and the room password becomes the only protection against strangers who
    find your open port. If any of that is a problem, use Tailscale.

TROUBLESHOOTING
  - "Could not reach the host": check address/port, that the room is running, and
    the host's firewall.
  - Connected but silent/black video: firewall is blocking UDP; allow GameChat on
    Private and Public networks on every PC.
  - Echo: use headphones or keep echo cancellation on.
  - Different versions: the app warns when the host runs another version; send
    friends the newest build.
  - If the host leaves, the room ends for everyone.

PRIVACY
  Voice/video/screen are end-to-end encrypted between friends (WebRTC). The
  host's small relay only passes connection handshakes and chat text; chat text
  is not encrypted, so use trusted networks or Tailscale. The room password is
  never sent in the clear (challenge-response hash).

BUILDING FROM SOURCE
  npm install, then: npm start (run), npm run dist (Windows installer + portable).
  npm test runs end-to-end tests with two real app instances, but the test/
  folder is not versioned (it is in .gitignore), so it only works on the PC
  that has it. Mac and Linux
  targets are configured (npm run dist:mac / dist:linux) but must be built on
  those systems and are untested.
