# MVR Presets for Pixelhue P80

A small app that saves and recalls **multiviewer (MVR) presets** on a Pixelhue P80: which layout each MVR uses and what's in every box. Recall them from a web page (Mac, PC or iPad) or from a **Bitfocus Companion** button.

Tested on a P80 with firmware V1.3.0.

---

## 1. Install (once)

1. Install **Node.js**: go to https://nodejs.org, download the **LTS** version and run the installer with the default options.
2. Unzip this folder somewhere you'll keep it (Documents is fine).

## 2. Start the app

**Mac:** double-click **`start.command`**.
The first time, macOS may say it can't be opened. If it does, **right-click → Open → Open**. You only have to do this once.

**Windows:** double-click **`start.bat`**.
The first time, Windows may show "Windows protected your PC". If it does, click **More info → Run anyway**. If Windows Firewall asks, click **Allow** (this lets an iPad or Companion reach the app).

A window opens showing something like:

```
PixelFlow MVR Presets is running.
  On this Mac:     http://localhost:3000
  From iPad/LAN:   http://10.0.0.237:3000
```

**Leave that window open** while you use the app. Close it to stop the app.

## 3. Open the page and connect

1. On the same computer, open **http://localhost:3000** in your browser.
2. Click **Processor…** (top right), type the P80's IP address and click **Save & connect**.
3. The dot at the top turns **green** when connected. The IP is remembered next time.

**At a new venue**, just change the IP in **Processor…**.

**From an iPad:** open the "From iPad/LAN" address shown in the window. On a Mac you can also use the computer's name, which doesn't change between networks: `http://<computer-name>.local:3000`. To find the name, look in **System Settings → General → Sharing**, at the bottom.

## 4. Make presets

**Capture what's on screen:** set a multiviewer up in PixelFlow, then click **Capture as preset** on that MVR, type a name and click **Save**.

**Build one:** click **+ New preset**, pick the multiviewer and a layout, then tap each box and choose its source. Boxes left empty are filled by the processor.

Colors match PixelFlow: **red** boxes take a screen's PGM, **green** boxes take PVW, **blue** boxes take inputs.

**Recall:** click **Recall** on a preset. A message confirms it, and lists any box it had to skip and why.

### Things the processor decides (not the app)

- **A source can only be in one multiviewer box at a time, across both MVRs.** If a preset for MVR 2 wants a source that MVR 1 is showing, that box is skipped (the editor warns you with "on MVR 1 now").
- **Box sizes and positions come from the layout.** For a different arrangement, make a custom layout in PixelFlow. It shows up in the app's Layout list.
- **Disabled inputs** don't appear in the list.

## 5. Companion buttons

1. In Companion, add the **Generic: HTTP Requests** connection. Leave its Base URL empty.
2. In the app, click **Copy** next to a preset to copy its URL, for example `http://10.0.0.237:3000/recall/show-open`.
3. On a Companion button, add a press action **Generic HTTP: GET** and paste that URL.

Tips:
- If Companion runs **on the same computer** as this app, use `http://localhost:3000/recall/...`. That never changes.
- If Companion is on another computer, make a Companion custom variable (e.g. `mvr_app` = `http://10.0.0.237:3000`) and use `$(internal:custom_mvr_app)/recall/show-open` in each button. At a new venue, update the one variable.
- Renaming a preset keeps its URL, so buttons keep working. Deleting a preset breaks its buttons.

## Troubleshooting

| Problem | Fix |
|---|---|
| Red dot / "Can't reach processor" | Check the IP in **Processor…**, and that this computer is on the P80's network. |
| "Port 3000 is already in use" | The app is already running in another window. Use that one, or close it and start again. |
| "Node.js is not installed" | Install the LTS version from https://nodejs.org. |
| iPad can't open the page | Use the "From iPad/LAN" address, make sure the iPad is on the same network, and (Windows) allow the app through the firewall. |
| A box was skipped | The message says why: usually the source is on the other MVR, or there was no free source to create that box. |

## Where things are saved

- `data/presets.json`: your presets. Copy this file to back them up or move them to another computer.
- `data/settings.json`: the processor IP.
- To use a different port than 3000, edit `PORT=` in the `.env` file.
