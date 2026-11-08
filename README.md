# Ferry

Instant file sharing between the devices on your local network: desktop, laptop, phone, tablet.
Nothing is uploaded anywhere. A shared file stays where it is, and whoever clicks **Download** pulls it straight from the device that shared it.

## Start

Double-click **`start.bat`**.

- The first run installs dependencies (needs internet once). After that it works fully offline.
- The panel opens in your browser, and the console window shows the address and a QR code for other devices, e.g. `http://192.168.1.24:8080`.
- **Closing the console window stops Ferry.** The share list lives in memory only, so the next launch starts empty.
- You can drop files or folders onto `start.bat` to share them as soon as it starts.

Other devices: open the address shown (or scan the QR code) in any browser on the same Wi-Fi/LAN.

> **Windows Firewall:** the first time, Windows asks whether Node.js may use the network. Allow **Private networks**. If phones can't connect, that's almost always the cause.

## How sharing works

| Shared from | How it's served | Needs to stay open |
|---|---|---|
| **The host PC**, via *Choose files / Choose folder* | Opens the PC's own file dialog; files are streamed straight from disk | Nothing; just keep Ferry running |
| **Any device's browser** (pick or drag & drop) | The browser streams the file through the host to the downloader as it's requested; nothing is stored on the host | That browser tab |

- **Real-time:** every device keeps one WebSocket open to the host. New shares, devices joining or leaving, and transfer progress appear instantly. There's no polling and no refreshing.
- **Folders** download as a `.zip` that's built on the fly (no compression, ZIP64, so there's no 4 GB limit). The browser shows real progress because the exact size is known up front.
- **Large files:** single files support HTTP range requests, so a download that's interrupted can resume. A share disappears for others when the tab holding it is closed or reloaded; if a phone just loses Wi-Fi for a moment, its shares come back when it reconnects.
- **Session-only:** when Ferry stops, everything is forgotten. Tabs that are still open notice the restart and start fresh too.

## Options

```
node server/index.js [--port 8080] [--name "Desktop-PC"] [--no-open] [paths to share…]
```

- `--port`: defaults to 8080; if it's taken, the next free port is used.
- `--name`: how this PC appears to others (defaults to the computer name). Any device can also rename itself by clicking its name chip in the panel.
- `--no-open`: don't open the browser on start.

## Security notes

Ferry is meant for a trusted home or office network. Anyone who can reach the address can see and download what's shared. Some built-in safeguards:
- Only the host PC can open its own file dialogs.
- Host disk paths are never shown to other devices.
- File names are sanitised so a zip can't write outside its folder.
- WebSocket connections must come from Ferry's own page.
- Unknown host names are rejected, which blocks DNS-rebinding attacks.

## Project layout

```
start.bat            launcher (closing its window stops the server)
server/index.js      startup, CLI, WebSocket upgrade
server/session.js    in-memory session: devices, shares, transfers, live broadcasts
server/downloads.js  disk files, browser relay, folder zips, range requests
server/zip.js        streaming ZIP64 writer with precomputed length
server/picker.js     native file/folder dialogs (Windows, macOS, Linux/zenity)
public/              the web panel (no build step)
```

Development: `npm run dev` restarts on changes. Set `FERRY_DEBUG_REMOTE=1` to make browsers on the host PC behave like remote devices, so you can preview what a phone sees.
