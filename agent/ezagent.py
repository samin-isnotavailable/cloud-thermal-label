#!/usr/bin/env python3
"""
EZ Label print agent (runs on the shop PC that has the label printer).

It asks the online app "any labels to print?" every few seconds and sends them straight to the
Xprinter. It only connects OUT to the internet, so no router settings are needed.

First run (in a normal window):   python ezagent.py
After that it starts by itself (see install_autostart.bat).

Other options:
  python ezagent.py --list-printers   show printer names Windows knows
  python ezagent.py --test            print one small test label directly (no internet needed)
  python ezagent.py --dry-run         don't print, write what would be printed to dry_run_output.txt
"""
import json, os, socket, sys, time, urllib.error, urllib.request
from datetime import datetime

VERSION = "1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "agent_config.json")
LOG = os.path.join(HERE, "agent.log")
DRY = "--dry-run" in sys.argv

BLOCKING = {0x1: "paused", 0x2: "printer error", 0x8: "paper jam", 0x10: "out of paper", 0x40: "paper problem",
            0x80: "offline", 0x1000: "not available", 0x100000: "needs attention", 0x200000: "out of memory", 0x400000: "cover open"}
ATTR_WORK_OFFLINE = 0x400
MAX_SPOOLED = 10          # don't feed the printer more while this many jobs are waiting in Windows


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 500_000:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    if sys.stdout:
        print(line, flush=True)


def load_config():
    if os.path.exists(CONFIG):
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    if not sys.stdin or not sys.stdin.isatty():
        log("Not set up yet. Open a normal window and run:  python ezagent.py")
        sys.exit(1)
    print("First-time setup.\n")
    server = input("App address (like https://ez-label-printing.yourname.workers.dev): ").strip().rstrip("/")
    key = input("Printer key (starts with ezk_): ").strip()
    cfg = {"server": server, "key": key, "printer_name": ""}
    api(cfg, "/api/agent/poll", {"want_job": False, "status": {"ok": True, "text": "Setting up"}, "version": VERSION})
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    print("\nConnected. Saved. Leave this window open to keep printing, or run install_autostart.bat so it starts with Windows.\n")
    return cfg


def api(cfg, path, body):
    req = urllib.request.Request(
        cfg["server"].rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": "Bearer " + cfg["key"], "user-agent": f"EZLabelAgent/{VERSION}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


# ---------- printer ----------
def printer_names():
    import win32print
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    return [p[2] for p in win32print.EnumPrinters(flags)]


def find_printer(cfg):
    if DRY:
        return "DRY-RUN"
    names = printer_names()
    want = (cfg.get("printer_name") or "").lower()
    for n in names:
        if want and want in n.lower():
            return n
    if not want:
        for n in names:
            if "365" in n or "xprinter" in n.lower():
                return n
    return None


def printer_state(name):
    """Return (ok, text, can_take_more_labels)."""
    if DRY:
        return True, "Dry run", True
    if not name:
        return False, "Printer not found in Windows", False
    import win32print
    try:
        h = win32print.OpenPrinter(name)
        try:
            info = win32print.GetPrinter(h, 2)
        finally:
            win32print.ClosePrinter(h)
    except Exception as e:
        return False, f"Can't reach printer ({e})", False
    problems = [t for bit, t in BLOCKING.items() if info["Status"] & bit]
    if info["Attributes"] & ATTR_WORK_OFFLINE:
        problems.append("set to use printer offline")
    if problems:
        return False, ", ".join(problems).capitalize(), False
    if info["cJobs"] >= MAX_SPOOLED:
        return True, "Busy printing", False
    return True, "Ready", True


def send_raw(name, data):
    if DRY:
        with open(os.path.join(HERE, "dry_run_output.txt"), "a", encoding="ascii") as f:
            f.write(data.decode("ascii") + "\n----\n")
        return
    import win32print
    h = win32print.OpenPrinter(name)
    try:
        win32print.StartDocPrinter(h, 1, ("EZ Gadgets labels", None, "RAW"))
        win32print.StartPagePrinter(h)
        win32print.WritePrinter(h, data)
        win32print.EndPagePrinter(h)
        win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)


def ack(cfg, ids, ok, error=""):
    for attempt in range(12):                 # keep trying for about a minute so a labels-printed report isn't lost
        try:
            api(cfg, "/api/agent/ack", {"ids": ids, "ok": ok, "error": error})
            return True
        except Exception as e:
            log(f"Could not report back yet ({e}); retrying")
            time.sleep(5)
    log("Gave up reporting results. The app will re-queue these labels after 2 minutes.")
    return False


def one_instance():
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 47653))
    except OSError:
        log("The agent is already running.")
        sys.exit(0)
    return s


def main():
    if "--list-printers" in sys.argv:
        print("\n".join(printer_names()))
        return
    if "--test" in sys.argv:
        cfg = {}
        name = find_printer(cfg)
        if not name:
            sys.exit("Xprinter not found. Run --list-printers.")
        send_raw(name, b'SIZE 39 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBAR 8,8,296,2\r\nTEXT 40,100,"2",0,1,1,"EZ AGENT TEST"\r\nBAR 8,230,296,2\r\nPRINT 1,1\r\n')
        print("Sent a test label to", name)
        return
    lock = one_instance()      # noqa: F841  (kept so the port stays taken)
    cfg = load_config()
    log(f"Agent {VERSION} started" + (" (dry run)" if DRY else ""))
    wait, backoff, last_text = 4.0, 0, None
    while True:
        try:
            name = find_printer(cfg)
            ok, text, can_take = printer_state(name)
            if text != last_text:
                log(f"Printer: {text}")
                last_text = text
            r = api(cfg, "/api/agent/poll", {"want_job": can_take, "status": {"ok": ok, "text": text}, "version": VERSION})
            wait = max(2.0, min(30.0, r.get("poll_ms", 4000) / 1000))
            backoff = 0
            job = r.get("job")
            if job:
                try:
                    send_raw(name, job["tspl"].encode("ascii"))
                    log(f"Printed {len(job['ids']) or 'test'} label(s) from job {job['id']}")
                    if job["ids"]:
                        ack(cfg, job["ids"], True)
                except Exception as e:
                    log(f"Print failed: {e}")
                    if job["ids"]:
                        ack(cfg, job["ids"], False, str(e)[:150])
                    time.sleep(5)
                continue                       # look for the next batch straight away
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                log("The app rejected this printer key. Ask an admin for a new key (Admin > Printers > New key) and delete agent_config.json.")
                backoff = 60
            elif e.code == 429 or e.code == 1027:
                log("The app is over its free daily limit. It resets at 6:00 AM Dhaka time.")
                backoff = 300
            else:
                log(f"Server error {e.code}")
                backoff = min(60, (backoff or 5) * 2)
        except Exception as e:
            backoff = min(60, (backoff or 5) * 2)
            log(f"No connection ({e}). Trying again in {backoff}s")
        time.sleep(backoff or wait)


if __name__ == "__main__":
    main()
