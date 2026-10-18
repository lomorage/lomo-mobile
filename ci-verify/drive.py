#!/usr/bin/env python3
"""Drives the Lomorage app on the CI emulator with adb + uiautomator, for PR #23 / #26 checks.
Usage: drive.py <scenario 23|26> <out_dir>
Every step saves a screenshot and the UI hierarchy to out_dir; result.json holds the measurements."""
import json, os, re, subprocess, sys, time
import xml.etree.ElementTree as ET

SCEN, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
PKG = 'com.wtao.lomo'
NET = os.environ.get('NETLOG', '/tmp/netlog')
T0 = time.time()
result = {'scenario': SCEN, 'variant': os.environ.get('VARIANT'), 'steps': []}
step_no = [0]

def log(msg, **kw):
    e = {'t': round(time.time() - T0, 1), 'msg': msg, **kw}
    print(json.dumps(e), flush=True)
    result['steps'].append(e)
    save()

def save():
    with open(f'{OUT}/result.json', 'w') as f:
        json.dump(result, f, indent=2)

def sh(cmd, check=False, timeout=120):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f'{cmd}: {p.stderr}')
    return p.stdout

def adb(args, **kw):
    return sh(f'adb {args}', **kw)

SCREEN = [1080, 2400]

def dump():
    for _ in range(5):
        out = adb('exec-out uiautomator dump /dev/tty', timeout=60)
        m = re.search(r'(<\?xml.*</hierarchy>)', out, re.S)
        if m:
            try:
                return ET.fromstring(m.group(1)), m.group(1)
            except ET.ParseError:
                pass
        time.sleep(1)
    return None, ''

def nodes(root):
    res = []
    if root is None:
        return res
    for n in root.iter('node'):
        b = re.findall(r'\d+', n.get('bounds', '[0,0][0,0]'))
        x1, y1, x2, y2 = map(int, b)
        res.append({'text': n.get('text', ''), 'desc': n.get('content-desc', ''), 'id': n.get('resource-id', ''),
                    'cls': n.get('class', ''), 'pkg': n.get('package', ''), 'clickable': n.get('clickable') == 'true',
                    'bounds': (x1, y1, x2, y2), 'cx': (x1 + x2) // 2, 'cy': (y1 + y2) // 2})
    return res

def texts():
    root, _ = dump()
    return [n['text'] or n['desc'] for n in nodes(root) if (n['text'] or n['desc'])]

def find(pattern, attr=('text', 'desc'), root=None, flags=re.I):
    if root is None:
        root, _ = dump()
    rx = re.compile(pattern, flags)
    return [n for n in nodes(root) if any(rx.search(n[a] or '') for a in attr)]

def clear_system_anr(root=None):
    """The emulator's own apps (Pixel Launcher, System UI) sometimes ANR on a cold CI boot; their
    dialog sits on top of everything. Press "Wait" on it (never touches the app under test)."""
    if root is None:
        root, _ = dump()
    ns = nodes(root)
    if any(re.search(r"isn.t responding", n['text'] or '') and PKG not in (n['text'] or '') for n in ns):
        w = [n for n in ns if re.fullmatch(r'(?i)wait', n['text'] or '')]
        if w:
            tap(w[0]); result.setdefault('system_anr_dismissed', 0); result['system_anr_dismissed'] += 1
            time.sleep(2); return True
    return False

def wait_for(pattern, timeout=60, attr=('text', 'desc')):
    end = time.time() + timeout
    while time.time() < end:
        root, _ = dump()
        if clear_system_anr(root):
            continue
        hits = find(pattern, attr, root=root)
        if hits:
            return hits
        time.sleep(1.5)
    return []

def tap(n):
    adb(f"shell input tap {n['cx']} {n['cy']}")

def tap_text(pattern, timeout=30, idx=0):
    hits = wait_for(pattern, timeout)
    if not hits:
        log('tap target not found', pattern=pattern)
        return False
    tap(hits[idx])
    log('tapped', pattern=pattern, text=hits[idx]['text'], at=[hits[idx]['cx'], hits[idx]['cy']])
    return True

def shot(name):
    step_no[0] += 1
    base = f'{OUT}/{step_no[0]:02d}-{name}'
    sh(f'adb exec-out screencap -p > {base}.png')
    _, xml = dump()
    with open(f'{base}.xml', 'w') as f:
        f.write(xml)
    log('screenshot', file=os.path.basename(base) + '.png', texts=[t for t in texts_from(xml)][:60])

def texts_from(xml):
    try:
        return [n['text'] or n['desc'] for n in nodes(ET.fromstring(xml)) if (n['text'] or n['desc'])]
    except Exception:
        return []

rec = {'n': 0, 'proc': None}
def rec_start():
    rec['n'] += 1
    rec['proc'] = subprocess.Popen(f"adb shell screenrecord --bit-rate 3000000 --time-limit 175 /data/local/tmp/rec{rec['n']}.mp4", shell=True)
def rec_stop():
    if rec['proc']:
        adb('shell pkill -INT screenrecord')
        try: rec['proc'].wait(10)
        except Exception: pass
        time.sleep(2)
        adb(f"pull /data/local/tmp/rec{rec['n']}.mp4 {OUT}/screenrecord-{rec['n']}.mp4")
        rec['proc'] = None
def rec_roll():
    rec_stop(); rec_start()

def netlog(file='requests.jsonl'):
    p = f'{NET}/{file}'
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p) if l.strip()]

def edit_texts():
    return [n for n in find('.', attr=('cls',)) if n['cls'] == 'android.widget.EditText']

def type_into(n, text, slow=False):
    tap(n); time.sleep(0.8)
    if slow:
        # one adb shell session, one `input text` per character (a person typing), timestamps
        # taken on the device before each character
        dev = 'for c in ' + ' '.join(text) + '; do echo "$(date +%s.%N) $c"; input text "$c"; done'
        out = subprocess.run(['adb', 'shell', dev], capture_output=True, text=True, timeout=180).stdout
        stamps = [l.split() for l in out.strip().splitlines() if l.strip()]
        result['keystrokes'] = stamps
        try:
            ts = [float(s[0]) for s in stamps]
            result['keystroke_gaps_s'] = [round(b - a, 3) for a, b in zip(ts, ts[1:])]
            result['typing_duration_s'] = round(ts[-1] - ts[0], 2)
        except Exception as e:
            result['keystroke_gaps_err'] = repr(e)
    else:
        subprocess.run(['adb', 'shell', 'input', 'text', text], timeout=60)
    time.sleep(0.5)

def hide_keyboard():
    # Only press BACK when the IME is actually up, otherwise BACK would leave the screen.
    d = adb('shell dumpsys input_method')
    if re.search(r'(mInputShown|isInputViewShown|mIsInputViewShown)=true', d):
        adb('shell input keyevent 4'); time.sleep(0.8)

def field_for(label):
    """The EditText right below the text label `label` (exact match), scrolling it into view."""
    for _ in range(8):
        root, _ = dump()
        ns = nodes(root)
        labels = [n for n in ns if re.fullmatch(label, n['text'] or '')]
        eds = [n for n in ns if n['cls'] == 'android.widget.EditText']
        if labels:
            lb = labels[0]
            below = [e for e in eds if lb['bounds'][3] - 5 <= e['bounds'][1] <= lb['bounds'][3] + 300]
            if below and 150 < below[0]['cy'] < SCREEN[1] * 0.85:
                return min(below, key=lambda e: e['bounds'][1])
            if lb['cy'] < 300:
                adb('shell input swipe 540 900 540 1500 400'); time.sleep(1); continue
        adb('shell input swipe 540 1600 540 1000 400'); time.sleep(1)
    return None

def fill_by_order(values):
    """Fills Username / Password / Confirm Password (located by their labels)."""
    for label, v in zip([r'Username', r'Password', r'Confirm Password'], values):
        e = field_for(label)
        if not e:
            log('field not found', label=label); shot('field-missing'); continue
        type_into(e, v)
        hide_keyboard()
        log('filled', label=label)

def start_app():
    adb(f'shell monkey -p {PKG} -c android.intent.category.LAUNCHER 1')

def screen_size():
    m = re.search(r'(\d+)x(\d+)', adb('shell wm size'))
    if m:
        SCREEN[0], SCREEN[1] = int(m.group(1)), int(m.group(2))

# ---------------------------------------------------------------- scenario #23
def scenario_23():
    for _ in range(5):
        clear_system_anr(); time.sleep(2)
    start_app()
    if not wait_for(r'Enter details manually', 120):
        shot('no-login-screen'); raise SystemExit('login screen not shown')
    shot('login')
    tap_text(r'Enter details manually')
    tap_text(r'Create one')
    if not wait_for(r'^Create Account$', 30):
        shot('no-register'); raise SystemExit('register screen not shown')
    time.sleep(2)
    shot('register-empty')
    srv = field_for(r'Server Address')
    t_type = time.time()
    log('typing server address character by character', address=ADDR)
    type_into(srv, ADDR, slow=True)
    log('typed address', seconds=round(time.time() - t_type, 1))
    hide_keyboard()
    time.sleep(3)
    shot('after-typing-address')
    fill_by_order(['alice', 'alice-pw-1', 'alice-pw-1'])
    shot('form-filled')
    # A first-time user takes a while over the rest of the form; the audit's Register tap came after
    # the partial-address lookups had timed out (axios: 60 s). Wait until 75 s after typing began.
    while time.time() - t_type < 75:
        time.sleep(5)
    shot('before-register-tap')
    result['connection_lost_before_register'] = bool(find(r'Connection Lost'))
    btn = find(r'Register & Log In')
    if not btn:
        adb('shell input swipe 540 1600 540 900 400'); time.sleep(1)
        btn = find(r'Register & Log In')
    if btn:
        tap(btn[0]); log('tapped Register & Log In')
    else:
        log('Register & Log In button not on screen (covered by a dialog?)')
        result['register_button_covered'] = True
        # tap where the button is on an unobstructed screen: lower middle
        adb(f'shell input tap {SCREEN[0]//2} {int(SCREEN[1]*0.85)}')
    time.sleep(20)
    shot('after-register-tap')
    result['connection_lost_after_register'] = bool(find(r'Connection Lost'))
    reqs = netlog()
    hang = netlog('hang.jsonl')
    result['requests'] = reqs
    result['hang_events'] = hang
    result['mount_requests_8000'] = sum(1 for r in reqs if r['url'].startswith('/mount'))
    result['post_user'] = [r for r in reqs if r['method'] == 'POST' and r['url'].rstrip('/') == '/user']
    result['partial_address_connections'] = sorted({h['port'] for h in hang if h['event'] == 'connect'})
    result['reached_home'] = bool(find(r'\d+ items?\b|YOUR FIRST BACKUP|Photos'))

# ---------------------------------------------------------------- scenario #26
def nav_settings():
    root, _ = dump()
    ns = nodes(root)
    cands = [n for n in ns if n['clickable'] and n['cy'] < SCREEN[1] * 0.15 and n['cx'] > SCREEN[0] * 0.75]
    if not cands:
        log('settings button not found'); return False
    n = max(cands, key=lambda n: n['cx'])
    tap(n); log('tapped settings', at=[n['cx'], n['cy']])
    return bool(wait_for(r'Backup Status|Free Up Space|Settings', 20))

def scroll_to(pattern, tries=10):
    for _ in range(tries):
        hits = find(pattern)
        if hits and hits[0]['cy'] < SCREEN[1] * 0.85:
            return hits
        adb('shell input swipe 540 1700 540 900 500'); time.sleep(1.2)
    return find(pattern)

def items_count():
    for n in find(r'^\d[\d,]* items?'):
        m = re.match(r'^([\d,]+) items?', n['text'])
        if m:
            return int(m.group(1).replace(',', ''))
    return None

def dismiss_dialogs(rounds=3):
    for _ in range(rounds):
        hits = find(r'^(OK|Got it|Not now|Later|Allow|While using the app)$')
        if not hits:
            return
        tap(hits[0]); log('dismissed', text=hits[0]['text']); time.sleep(1.5)

def scenario_26():
    n_photos = int(os.environ.get('N_PHOTOS', '6'))
    for _ in range(10):  # let the launcher settle after a cold boot
        clear_system_anr(); time.sleep(3)
    # the setup link a server's QR code carries; -p sends it to the app (not Chrome). One argv
    # string so the device shell sees the quotes around '#' and '&'.
    out = subprocess.run(['adb', 'shell', f"am start -W -a android.intent.action.VIEW -p {PKG} -d 'https://lomorage.com/s/#server=10.0.2.2%3A8000&name=CI-lomod'"],
                         capture_output=True, text=True, timeout=120)
    log('setup link sent', out=out.stdout[-400:], err=out.stderr[-400:])
    if not wait_for(r'Connect to this server', 120):
        shot('no-setup-prompt'); raise SystemExit('setup prompt not shown')
    shot('setup-prompt')
    tap_text(r'^continue$')
    if not wait_for(r'^Create Account$', 30):
        shot('no-register'); raise SystemExit('register screen not shown')
    wait_for(r'GB|MB', 30)  # disk listed
    time.sleep(2)
    shot('register-prefilled')
    fill_by_order(['alice', 'alice-pw-1', 'alice-pw-1'])
    btn = find(r'Register & Log In') or (adb('shell input swipe 540 1600 540 900 400') or find(r'Register & Log In'))
    tap(btn[0]); log('tapped Register & Log In')
    time.sleep(15)
    dismiss_dialogs()
    shot('home-after-login')
    # wait for the backup to finish: n_photos successful uploads through the proxy
    end = time.time() + 600
    while time.time() < end:
        ups = [r for r in netlog() if r['method'] in ('POST', 'PATCH') and r['url'].startswith('/asset') and r.get('status') == 200]
        if len({u['url'] for u in ups}) >= n_photos:
            break
        dismiss_dialogs(1)
        time.sleep(5)
    log('uploads seen', count=len({u['url'] for u in ups}))
    time.sleep(30)
    shot('home-backed-up')
    # Reopen the app once, as a person would, so the post-backup sync has mirrored the computer's
    # (hash-keyed) rows before Free Up Space runs, the state the audit was in.
    adb(f'shell am force-stop {PKG}'); time.sleep(2); start_app()
    wait_for(r'^\d[\d,]* items?', 90); time.sleep(40); dismiss_dialogs()
    rec_roll()
    shot('home-reopened-before-free-up')
    result['items_before_free_up'] = items_count()
    if not nav_settings():
        shot('no-settings'); raise SystemExit('settings not reached')
    shot('settings')
    hits = scroll_to(r'^Free Up Space$')
    tap(hits[0]); log('opened Free Up Space')
    wait_for(r'Select All', 60)
    time.sleep(3)
    shot('free-up-space')
    for tabrx in (r'^Photos? \((?!0\))', r'^Videos? \((?!0\))'):
        if find(tabrx):
            tap_text(tabrx); time.sleep(2)
            tap_text(r'^Select All'); time.sleep(1)
    shot('free-up-selected')
    dels = [n for n in find(r'^Delete$') if n['pkg'] == PKG]
    tap(dels[-1]); log('tapped Delete')
    if wait_for(r'Delete from Device', 90):
        shot('confirm-dialog')
        b1 = find(r'android:id/button1', attr=('id',))
        tap(b1[0]) if b1 else tap_text(r'^delete$')
        log('confirmed in-app dialog')
    else:
        shot('no-confirm-dialog')
    if wait_for(r'^Allow$', 30):
        shot('system-delete-dialog')
        tap_text(r'^Allow$')
    wait_for(r'Success|Partly Done|Error', 60)
    shot('after-delete')
    result['free_up_alert'] = [t for t in texts() if re.search(r'Success|Partly|Error|freed', t, re.I)]
    b1 = find(r'android:id/button1', attr=('id',))
    if b1: tap(b1[0])
    time.sleep(2)
    rec_roll()
    adb('shell input keyevent 4'); time.sleep(2)
    adb('shell input keyevent 4'); time.sleep(5)
    shot('home-right-after-free-up')
    result['items_right_after_free_up'] = items_count()
    time.sleep(30)
    shot('home-30s-after-free-up')
    result['items_30s_after_free_up'] = items_count()
    # and once more after reopening the app
    adb(f'shell am force-stop {PKG}'); time.sleep(2); start_app()
    wait_for(r'^\d[\d,]* items?', 90); time.sleep(30); dismiss_dialogs()
    shot('home-reopened-after-free-up')
    result['items_after_reopen'] = items_count()
    nav_settings()
    hits = scroll_to(r'^Backup Status$')
    tap(hits[0]); log('opened Backup Status')
    wait_for(r'safe at home|Nothing is backed up|missing|couldn|reach', 120)
    time.sleep(3)
    shot('backup-status')
    result['backup_status_texts'] = texts()
    result['backup_status_title'] = next((t for t in result['backup_status_texts']
                                          if re.search(r'safe at home|Nothing is backed up yet|missing from your computer|reach', t, re.I)), None)
    result['requests'] = netlog()

ADDR = os.environ.get('ADDR', '10.0.2.2:8000')
screen_size()
log('screen', size=SCREEN)
adb('logcat -c')
logcat = subprocess.Popen(f'adb logcat -v threadtime > {OUT}/logcat.txt', shell=True)
rec_start()
try:
    {'23': scenario_23, '26': scenario_26}[SCEN]()
except SystemExit as e:
    result['aborted'] = str(e); log('aborted', reason=str(e))
except Exception as e:
    result['error'] = repr(e); log('error', err=repr(e))
    try: shot('error')
    except Exception: pass
finally:
    rec_stop()
    time.sleep(2)
    logcat.terminate()
    sh(f"grep -E 'ReactNativeJS|AndroidRuntime|FATAL' {OUT}/logcat.txt > {OUT}/logcat-js.txt || true")
    try:
        js = open(f'{OUT}/logcat-js.txt', errors='replace').read()
        result['logcat_fetching_disks'] = re.findall(r'Fetching available disks from:?\s*\S+', js)
        result['logcat_connection_lost_related'] = len(re.findall(r'dual-connection failover|Connection Lost', js))
    except Exception:
        pass
    save()
