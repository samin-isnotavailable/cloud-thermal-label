# EZ Label Printing: setup guide

Staff open a web page from any phone or PC, scan or type serials, and press Print. A small program on the shop PC (the agent) picks up the job and prints it on the XP-365B. It only connects out to the internet, so no router settings are needed. Everything runs on Cloudflare's free plan.

## Part 1: put the app online (about 15 minutes, once)

Do this on any Windows PC. It does not have to be the shop PC.

1. Install **Node.js** (the LTS version) from https://nodejs.org. Accept the defaults.
2. Create a free **Cloudflare** account at https://dash.cloudflare.com/sign-up. No card is needed for the free plan.
3. Open this `label-app` folder in File Explorer, click the address bar, type `cmd` and press Enter.
4. Run these three commands, one at a time:
   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   `login` opens your browser. Click Allow. `deploy` may ask you to choose a free `workers.dev` name. Pick anything. When it finishes it prints your address, like `https://ez-label-printing.yourname.workers.dev`. Save it.
   Wrangler creates the database by itself on the first deploy.
   If it complains about the database, run `npx wrangler d1 create ez-labels`, copy the `database_id` it prints into `wrangler.jsonc` under `"database_name": "ez-labels"` as `"database_id": "..."`, and run `npx wrangler deploy` again.
5. Open your address right away. The first screen creates the **admin account**. Do this immediately, because whoever gets there first becomes the admin.

## Part 2: add the printer

1. Sign in, then go to **Admin > Printers**, type a name (for example Counter) and click **Add printer**.
2. A key starting with `ezk_` appears. It is shown only once. Copy it. If you lose it, click **New key** on that printer.

## Part 3: the shop PC (about 5 minutes, once)

1. Copy the `agent` folder to the shop PC, for example to `C:\EZLabelAgent`.
2. Make sure Python is installed, then open a window in that folder (address bar, type `cmd`, Enter) and run:
   ```
   pip install pywin32
   python ezagent.py --list-printers
   python ezagent.py
   ```
   The first command installs the printer library. The second should show your XP-365B. If its name does not include "365" or "Xprinter", open `agent_config.json` after step 3 and put part of the real name in `printer_name`.
3. When asked, paste the app address and the printer key. It says "Connected".
4. Close that window and run **install_autostart.bat**. From now on the agent starts by itself every time Windows starts and you sign in, with no window. It writes what it does to `agent.log`.
5. In the web app, the top right should show **Counter: ready**.

Set the shop PC to never sleep (Windows Settings > System > Power). If the PC is asleep, labels wait in the queue and print when it wakes.

## Part 4: first prints

1. Go to **Admin > Printers > Darkness test**. Four labels print, marked D4, D6, D8 and D10. Scan each. Put the darkness that scans fastest into **Darkness** and click **Save settings**.
2. Go to **Print**, pick a model, scan or type serials, press Enter after each, and click Print.
3. Add staff under **Admin > Staff**. Each person gets their own name and password, and History shows who printed what.

## Long serials that scan poorly (Stretch test)

A serial with letters, like EE7B2010260012, needs about 145 bars. On a 38 or 39 mm label that only fits with 1-dot bars, which a camera scanner reads poorly. The app can widen those barcodes by mixing 1-dot and 2-dot bars.

1. **Admin > Printers > Stretch test**, type a long serial and click Print 4 labels. They are marked S1 (normal), S2 (mild), S3 (medium) and S4 (wide).
2. Scan each one with the scanner you really use. Pick the one that reads best.
3. Set **Thin barcodes** on that printer to the same level and click **Save settings**.

This only changes barcodes that would otherwise print with 1-dot bars. A label at least 40 mm wide prints this serial with 2-dot bars and does not need it.

## Everyday use

- **Model list:** choose from the dropdown, or click Add new. Any staff member can add a model. Only admins can remove one.
- **Serials with a different model in one batch:** in a pasted list, write `serial,model` on a line.
- **Duplicates:** a serial that was already printed shows in amber, and Print asks before printing it again.
- **Reprint a damaged label:** History, tick the label, Reprint selected.
- **New label size or number of barcodes:** Admin > Label templates > New template. Set the size in mm and the items top to bottom. The preview warns if the bars get too thin. When you change paper, calibrate the printer's gap sensor as before. The paper size in Windows printer settings no longer matters.

## Free plan limits

- Cloudflare's free plan allows **100,000 requests a day** to the app. The agent uses about 21,600 a day (one every 4 seconds), and each open web page adds a small amount. Three staff and one printer stay well under the limit. A second printer adds about 21,600 more.
- If the limit is ever hit, printing pauses until it resets at **6:00 AM Dhaka time**. The agent keeps trying and catches up by itself.
- Each request may use at most 10 ms of processor time on the free plan. Batches are kept small for this reason. I measured about 5 ms per batch on my machine, but I could not test on Cloudflare itself. If you ever see "Something went wrong on the server" while printing, tell me. The paid plan ($5 a month) removes the limit.

## If something goes wrong

| What you see | What to do |
|---|---|
| Top right says "print agent offline" | The shop PC is off, asleep or offline. Check `agent.log` there, or run `python ezagent.py` in a window to see messages. |
| "Printer not found in Windows" | Run `python ezagent.py --list-printers` and put part of the name in `printer_name` in `agent_config.json`. |
| Label prints but shifted | Admin > Printers > Shift right / Shift down (8 dots = 1 mm). Upside down: set Direction to Flipped. |
| "The app rejected this printer key" in the log | Admin > Printers > New key. Delete `agent_config.json` on the shop PC and run `python ezagent.py` again. |
| The internet is down | Printing from the web app stops. Use `print_labels.py` on the shop PC as the backup, exactly as before. |
| You forgot the admin password | Tell me and I will give you a one-line command that resets it. |

## Updating the app later

Change the files, then run `npx wrangler deploy` again. Your data (staff, models, history) stays. The agent rarely needs updating, because the label layout is built on the server.

## Files

- `src/worker.js`: the server (logins, queue, history)
- `public/`: the web pages and the label engine (`engine.js`)
- `agent/`: the Windows print agent and its auto-start files
