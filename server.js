#!/usr/bin/env node
// Mvn Dashboard - GUI nhỏ để quản lý & build nhiều project Maven độc lập.
// Chạy:  node server.js [--root <thư mục>] [--port 8765] [--no-browser]
// Không truyền --root thì chọn thư mục ngay trên giao diện.
// Không cần npm install, chỉ dùng module chuẩn của Node 18+.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const HERE = __dirname;
const DATA_DIR = path.join(os.homedir(), '.mvn-dashboard');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_LOG_LINES = 20000;
const MAX_RECENT = 8;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());

// ---------------------------------------------------------------- args ----

function parseArgs(argv) {
  const args = { root: null, port: 8765, browser: true, dev: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dev') args.dev = true;
    if (argv[i] === '--root') args.root = path.resolve(expandHome(argv[++i]));
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--no-browser') args.browser = false;
  }
  return args;
}
const ARGS = parseArgs(process.argv.slice(2));
const BOOT_ID = Date.now().toString(36);

// --------------------------------------------------------------- state ----

const state = {
  root: null,
  modules: {},      // name -> info
  logs: {},         // name -> string[]
  procs: {},        // name -> ChildProcess
  jdks: [],
  busy: new Set(),   // module đang chạy lệnh git/exec
  clients: new Set(),
  running: false,
  cancelRequested: false,
  saved: loadSaved(),
};

// saved = { recentRoots: [], options: {}, roots: { <root>: { history: {}, presets: {} } } }
function loadSaved() {
  try {
    return { recentRoots: [], options: {}, roots: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { recentRoots: [], options: {}, roots: {} };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFile(STATE_FILE, JSON.stringify(state.saved, null, 2), () => {});
}

function rootData() {
  return (state.saved.roots[state.root] ||= { history: {}, presets: {} });
}

function logDir() {
  const hash = crypto.createHash('md5').update(state.root).digest('hex').slice(0, 8);
  return path.join(DATA_DIR, 'logs', `${path.basename(state.root)}-${hash}`);
}

function broadcast(event) {
  const chunk = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.clients) res.write(chunk);
}

// ------------------------------------------------------------- scanning ----

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`));
  return m ? m[1] : null;
}

function parsePom(file) {
  const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const parent = (xml.match(/<parent>[\s\S]*?<\/parent>/) || [''])[0];
  // Bỏ các block lồng nhau để lấy toạ độ cấp project
  const top = xml.replace(
    /<(parent|dependencies|dependencyManagement|build|profiles|properties|modules|repositories|pluginRepositories|distributionManagement|reporting)>[\s\S]*?<\/\1>/g,
    '',
  );
  const deps = [...xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)]
    .map((m) => tag(m[1], 'artifactId'))
    .filter(Boolean);
  return {
    groupId: tag(top, 'groupId') || tag(parent, 'groupId'),
    artifactId: tag(top, 'artifactId'),
    version: tag(top, 'version') || tag(parent, 'version'),
    packaging: tag(top, 'packaging') || 'jar',
    javaVersion: tag(xml, 'java\\.version') || tag(xml, 'maven\\.compiler\\.release') || tag(xml, 'maven\\.compiler\\.source'),
    rawDeps: deps,
  };
}

// --------------------------------------------------------------- JDKs ----

// macOS: liệt kê JDK qua java_home -V (stderr), sắp xếp mới -> cũ
function listJdks() {
  return new Promise((resolve) => {
    execFile('/usr/libexec/java_home', ['-V'], (err, stdout, stderr) => {
      const jdks = [];
      for (const line of String(stderr || '').split('\n')) {
        const m = line.match(/^\s+(\d[\w.+-]*)\s.*?"\s+(\/.+)$/);
        if (m) jdks.push({ version: m[1], major: majorOf(m[1]), home: m[2].trim(), label: line.trim() });
      }
      resolve(jdks);
    });
  });
}

function majorOf(v) {
  const s = String(v || '').replace(/^1\./, '');
  return parseInt(s, 10) || null;
}

// opts.javaHome: '' / 'auto' = theo java.version trong pom; còn lại là đường dẫn JDK cụ thể
function resolveJavaHome(mod, opts) {
  if (opts.javaHome && opts.javaHome !== 'auto') return opts.javaHome;
  const want = majorOf(mod.javaVersion);
  if (!want) return null;
  const exact = state.jdks.find((j) => j.major === want);
  return (exact || state.jdks.filter((j) => j.major > want).pop() || {}).home || null;
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 10000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function gitInfo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const [branch, status, ab] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
  ]);
  if (branch == null) return null;
  const [behind, ahead] = (ab || '0 0').trim().split(/\s+/).map(Number);
  return {
    branch: branch.trim(),
    dirty: (status || '').split('\n').filter((l) => l.trim()).length,
    ahead: ahead || 0,
    behind: behind || 0,
  };
}

async function scan() {
  const found = {};
  // Thư mục con có pom.xml; nếu bản thân root là project Maven thì cũng tính
  const dirs = fs.readdirSync(state.root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(state.root, d.name, 'pom.xml')))
    .map((d) => ({ name: d.name, dir: path.join(state.root, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (fs.existsSync(path.join(state.root, 'pom.xml'))) dirs.unshift({ name: `${path.basename(state.root)} (root)`, dir: state.root });

  await Promise.all(dirs.map(async ({ name, dir }) => {
    let info;
    try {
      info = parsePom(path.join(dir, 'pom.xml'));
    } catch (e) {
      info = { artifactId: name, rawDeps: [], error: String(e) };
    }
    found[name] = {
      ...info,
      name,
      path: dir,
      // mvnw chỉ dùng được khi có kèm .mvn/wrapper/maven-wrapper.properties
      hasWrapper: fs.existsSync(path.join(dir, 'mvnw'))
        && fs.existsSync(path.join(dir, '.mvn', 'wrapper', 'maven-wrapper.properties')),
      git: await gitInfo(dir),
    };
  }));

  // Dependency nội bộ: khớp artifactId giữa các module đã scan
  const byArtifact = {};
  for (const [n, m] of Object.entries(found)) if (m.artifactId) byArtifact[m.artifactId] = n;
  const history = rootData().history;
  const ordered = {};
  for (const { name: n } of dirs) {
    const m = found[n];
    m.deps = [...new Set(m.rawDeps.map((a) => byArtifact[a]).filter((d) => d && d !== n))].sort();
    delete m.rawDeps;
    const old = state.modules[n] || {};
    m.status = old.status || 'idle';
    m.startedAt = old.startedAt || null;
    m.duration = old.duration ?? null;
    m.last = history[n] || null;
    m.busy = state.busy.has(n);
    ordered[n] = m;
  }
  state.modules = ordered;
  return ordered;
}

async function setRoot(dir) {
  const root = path.resolve(expandHome(dir));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Không tìm thấy thư mục: ${root}`);
  if (root !== state.root) {
    state.root = root;
    state.modules = {};
    state.logs = {};
  }
  state.saved.recentRoots = [root, ...state.saved.recentRoots.filter((r) => r !== root)].slice(0, MAX_RECENT);
  save();
  await scan();
}

// Liệt kê thư mục con để chọn folder ngay trên web
function browse(dir) {
  const target = path.resolve(expandHome(dir || os.homedir()));
  const dirs = fs.readdirSync(target, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, hasPom: fs.existsSync(path.join(target, d.name, 'pom.xml')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: target,
    parent: path.dirname(target) !== target ? path.dirname(target) : null,
    hasPom: fs.existsSync(path.join(target, 'pom.xml')),
    pomCount: dirs.filter((d) => d.hasPom).length,
    dirs,
  };
}

// Hộp thoại chọn folder native của macOS
function pickFolderNative() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ unsupported: true });
    const script = 'tell application (path to frontmost application as text) to POSIX path of '
      + '(choose folder with prompt "Chọn thư mục chứa các project Maven")';
    execFile('osascript', ['-e', script], (err, stdout) => {
      resolve(err ? { cancelled: true } : { path: stdout.trim().replace(/\/$/, '') });
    });
  });
}

// ------------------------------------------------------- git & lệnh lẻ ----

async function listBranches(dir) {
  const [current, refs] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)|%(refname:short)|%(committerdate:relative)',
      'refs/heads', 'refs/remotes']),
  ]);
  const local = [];
  const remote = [];
  for (const line of (refs || '').split('\n').filter(Boolean)) {
    const [full, name, when] = line.split('|');
    if (full.startsWith('refs/heads/')) local.push({ name, when });
    else if (!full.endsWith('/HEAD') && name.includes('/')) remote.push({ name, when });
  }
  // Ẩn remote branch đã có bản local cùng tên
  const localNames = new Set(local.map((b) => b.name));
  return {
    current: (current || '').trim(),
    local,
    remote: remote.filter((b) => !localNames.has(b.name.replace(/^[^/]+\//, ''))),
  };
}

function gitCommand(action, branch, remote) {
  switch (action) {
    case 'fetch': return ['git', 'fetch', '--all', '--prune'];
    case 'pull': return ['git', 'pull', '--ff-only'];
    case 'submodules': return ['git', 'submodule', 'update', '--init', '--recursive'];
    case 'checkout':
      if (!branch || branch.startsWith('-')) return null;
      // remote branch (origin/foo) -> tạo local branch tracking
      return remote ? ['git', 'checkout', '--track', branch] : ['git', 'checkout', branch];
    default: return null;
  }
}

// Chạy một lệnh trong thư mục module, đẩy output vào log của module đó
function runTask(name, cmd, { shell = false } = {}) {
  return new Promise((resolve) => {
    const mod = state.modules[name];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const javaHome = resolveJavaHome(mod, {});
    if (javaHome) {
      env.JAVA_HOME = javaHome;
      env.PATH = path.join(javaHome, 'bin') + path.delimiter + env.PATH;
    }
    const [bin, args] = shell ? [process.env.SHELL || '/bin/sh', ['-lc', cmd]] : [cmd[0], cmd.slice(1)];
    appendLog(name, `$ ${shell ? cmd : cmd.join(' ')}`);
    state.busy.add(name);
    mod.busy = true;
    broadcast({ type: 'task', module: name, running: true });
    // stdin ignore: lệnh đòi nhập liệu sẽ nhận EOF thay vì treo
    const child = spawn(bin, args, { cwd: mod.path, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    state.procs[name] = child;
    let partial = '';
    const onData = (chunk) => {
      const lines = (partial + chunk.toString()).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) appendLog(name, l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let finished = false;
    const finish = async (code, errMsg) => {
      if (finished) return;
      finished = true;
      if (partial) appendLog(name, partial);
      if (errMsg) appendLog(name, `[dashboard] Không chạy được lệnh: ${errMsg}`);
      appendLog(name, `[dashboard] exit=${code}`);
      delete state.procs[name];
      state.busy.delete(name);
      const cur = state.modules[name] || mod;  // có thể đã rescan trong lúc chạy
      cur.busy = false;
      cur.git = await gitInfo(mod.path);
      broadcast({ type: 'task', module: name, running: false, code, git: cur.git });
      resolve(code);
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code ?? -1));
  });
}

function killModule(name) {
  const child = state.procs[name];
  if (!child) return false;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* đã thoát */
  }
  return true;
}

// --------------------------------------------------------------- builds ----

function buildCommand(mod, opts) {
  const useWrapper = mod.hasWrapper && opts.useWrapper !== false;
  const cmd = [useWrapper ? './mvnw' : 'mvn', '-B', ...(opts.goals || 'clean install').split(/\s+/).filter(Boolean)];
  if (opts.skipTests) cmd.push('-DskipTests');
  if (opts.offline) cmd.push('-o');
  if (opts.updateSnapshots) cmd.push('-U');
  if (opts.profiles && opts.profiles.trim()) cmd.push('-P' + opts.profiles.trim());
  if (opts.extraArgs) cmd.push(...opts.extraArgs.split(/\s+/).filter(Boolean));
  return cmd;
}

function setStatus(name, status, extra = {}) {
  const m = state.modules[name];
  if (!m) return;
  Object.assign(m, { status }, extra);
  broadcast({ type: 'status', module: name, status, duration: m.duration, startedAt: m.startedAt });
}

function appendLog(name, line, stream) {
  line = line.replace(ANSI_RE, '');
  const buf = (state.logs[name] ||= []);
  buf.push(line);
  if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
  if (stream) stream.write(line + '\n');
  broadcast({ type: 'log', module: name, line });
}

function runModule(name, opts) {
  return new Promise((resolve) => {
    const mod = state.modules[name];
    const cmd = buildCommand(mod, opts);
    const env = { ...process.env };
    const javaHome = resolveJavaHome(mod, opts);
    if (javaHome) {
      env.JAVA_HOME = javaHome;
      env.PATH = path.join(javaHome, 'bin') + path.delimiter + env.PATH;
    }
    state.logs[name] = [];
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const logFile = fs.createWriteStream(path.join(dir, `${name}.log`));
    const start = Date.now();
    setStatus(name, 'running', { startedAt: start, duration: null });
    appendLog(name, `$ cd ${mod.path} && ${cmd.join(' ')}`, logFile);
    appendLog(name, javaHome
      ? `[dashboard] JAVA_HOME=${javaHome} (pom yêu cầu Java ${mod.javaVersion || '?'})`
      : `[dashboard] Không tìm thấy JDK ${mod.javaVersion || ''} phù hợp, dùng Java mặc định của hệ thống`, logFile);

    // detached: tạo process group riêng để cancel kill được cả cây process
    const child = spawn(cmd[0], cmd.slice(1), { cwd: mod.path, env, detached: true });
    state.procs[name] = child;

    let partial = '';
    const onData = (chunk) => {
      const lines = (partial + chunk.toString()).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) appendLog(name, l, logFile);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const finish = (code, errMsg) => {
      if (partial) appendLog(name, partial, logFile);
      if (errMsg) appendLog(name, `[dashboard] Không chạy được lệnh: ${errMsg}`, logFile);
      delete state.procs[name];
      const duration = Math.round((Date.now() - start) / 100) / 10;
      const status = code === 0 ? 'success' : state.cancelRequested ? 'cancelled' : 'failed';
      appendLog(name, `[dashboard] exit=${code} sau ${duration}s`, logFile);
      logFile.end();
      setStatus(name, status, { duration });
      const entry = { status, at: Date.now(), duration, goals: opts.goals };
      rootData().history[name] = entry;
      mod.last = entry;
      save();
      resolve(status === 'success');
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code ?? -1));
  });
}

// Chạy theo đồ thị dependency, tối đa `parallel` module cùng lúc
async function runBatch(names, opts) {
  const parallel = Math.max(1, Number(opts.parallel) || 1);
  const selected = names.filter((n) => state.modules[n]);
  const deps = Object.fromEntries(selected.map((n) => [n, state.modules[n].deps.filter((d) => selected.includes(d))]));
  selected.forEach((n) => setStatus(n, 'queued', { duration: null }));
  broadcast({ type: 'batch', running: true });

  const done = new Set();
  const failed = new Set();
  const active = new Map();
  let pending = [...selected];

  await new Promise((resolveBatch) => {
    const tick = () => {
      if (state.cancelRequested) {
        pending.forEach((n) => setStatus(n, 'cancelled'));
        pending = [];
      }
      for (const n of [...pending]) {
        if (deps[n].some((d) => failed.has(d))) {
          pending = pending.filter((x) => x !== n);
          failed.add(n);
          setStatus(n, 'skipped');
          appendLog(n, '[dashboard] Bỏ qua vì dependency build lỗi');
          continue;
        }
        if (active.size < parallel && deps[n].every((d) => done.has(d))) {
          pending = pending.filter((x) => x !== n);
          active.set(n, runModule(n, opts).then((ok) => {
            active.delete(n);
            (ok ? done : failed).add(n);
            if (!ok && opts.stopOnError) state.cancelRequested = true;
            tick();
          }));
        }
      }
      if (!pending.length && !active.size) resolveBatch();
    };
    tick();
  });

  state.running = false;
  state.cancelRequested = false;
  broadcast({ type: 'batch', running: false, ok: [...done], failed: [...failed] });
}

function cancelAll() {
  state.cancelRequested = true;
  for (const child of Object.values(state.procs)) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* đã thoát */
    }
  }
}

// ----------------------------------------------------------------- http ----

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function overview() {
  return {
    root: state.root,
    recentRoots: state.saved.recentRoots.filter((r) => fs.existsSync(r)),
    running: state.running,
    modules: Object.values(state.modules),
    jdks: state.jdks,
    presets: state.root ? rootData().presets : {},
    options: state.saved.options,
  };
}

const routes = {
  'GET /': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(HERE, 'index.html')).pipe(res);
  },

  'GET /api/modules': async (req, res, url) => {
    if (state.root && url.searchParams.get('rescan')) await scan();
    sendJson(res, overview());
  },

  'POST /api/root': async (req, res) => {
    const data = await readBody(req);
    if (state.running) return sendJson(res, { error: 'Đang có batch chạy, dừng trước khi đổi folder' }, 409);
    try {
      await setRoot(data.path || '');
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
    sendJson(res, overview());
  },

  'POST /api/recent/remove': async (req, res) => {
    const data = await readBody(req);
    state.saved.recentRoots = state.saved.recentRoots.filter((r) => r !== data.path);
    save();
    sendJson(res, { recentRoots: state.saved.recentRoots });
  },

  'GET /api/browse': (req, res, url) => {
    try {
      sendJson(res, browse(url.searchParams.get('path')));
    } catch (e) {
      sendJson(res, { error: e.message }, 400);
    }
  },

  'POST /api/pick': async (req, res) => {
    sendJson(res, await pickFolderNative());
  },

  'GET /api/branches': async (req, res, url) => {
    const mod = state.modules[url.searchParams.get('module')];
    if (!mod) return sendJson(res, { error: 'Không có module' }, 404);
    sendJson(res, await listBranches(mod.path));
  },

  'POST /api/git': async (req, res) => {
    const data = await readBody(req);
    const mod = state.modules[data.module];
    if (!mod) return sendJson(res, { error: 'Không có module' }, 404);
    if (state.busy.has(mod.name) || ['running', 'queued'].includes(mod.status)) return sendJson(res, { error: 'Module đang bận' }, 409);
    const cmd = gitCommand(data.action, data.branch, data.remote);
    if (!cmd) return sendJson(res, { error: 'Lệnh git không hợp lệ' }, 400);
    const code = await runTask(mod.name, cmd);
    sendJson(res, { ok: code === 0, code, git: state.modules[mod.name]?.git });
  },

  'POST /api/exec': async (req, res) => {
    const data = await readBody(req);
    const mod = state.modules[data.module];
    if (!mod) return sendJson(res, { error: 'Không có module' }, 404);
    if (!data.cmd || !String(data.cmd).trim()) return sendJson(res, { error: 'Lệnh trống' }, 400);
    if (state.busy.has(mod.name) || ['running', 'queued'].includes(mod.status)) return sendJson(res, { error: 'Module đang bận' }, 409);
    runTask(mod.name, String(data.cmd), { shell: true });
    sendJson(res, { ok: true });
  },

  'POST /api/kill': async (req, res) => {
    const data = await readBody(req);
    sendJson(res, { ok: killModule(data.module) });
  },

  'POST /api/log/clear': async (req, res) => {
    const data = await readBody(req);
    const names = data.all ? Object.keys(state.logs) : [data.module];
    for (const n of names) state.logs[n] = [];
    broadcast({ type: 'logcleared', modules: names });
    sendJson(res, { ok: true });
  },

  'GET /api/log': (req, res, url) => {
    const name = url.searchParams.get('module');
    sendJson(res, { module: name, lines: state.logs[name] || [] });
  },

  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // boot id: trình duyệt so sánh khi kết nối lại để biết server vừa khởi động lại
    res.write(`data: ${JSON.stringify({ type: 'hello', boot: BOOT_ID, dev: ARGS.dev })}\n\n`);
    state.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      state.clients.delete(res);
    });
  },

  'POST /api/build': async (req, res) => {
    const data = await readBody(req);
    if (!state.root) return sendJson(res, { error: 'Chưa chọn folder' }, 400);
    if (state.running) return sendJson(res, { error: 'Đang có batch chạy' }, 409);
    const busy = (data.modules || []).filter((n) => state.busy.has(n));
    if (busy.length) return sendJson(res, { error: `Đang chạy lệnh ở: ${busy.join(', ')}` }, 409);
    state.running = true;
    state.cancelRequested = false;
    state.saved.options = data.options || {};
    save();
    runBatch(data.modules || [], data.options || {});
    sendJson(res, { ok: true });
  },

  'POST /api/cancel': (req, res) => {
    cancelAll();
    sendJson(res, { ok: true });
  },

  'POST /api/presets': async (req, res) => {
    const data = await readBody(req);
    if (!state.root) return sendJson(res, { error: 'Chưa chọn folder' }, 400);
    if (!data.name) return sendJson(res, { error: 'Thiếu tên preset' }, 400);
    const presets = rootData().presets;
    if (data.delete) delete presets[data.name];
    else presets[data.name] = data.modules || [];
    save();
    sendJson(res, { presets });
  },

  'POST /api/open': async (req, res) => {
    const data = await readBody(req);
    const mod = state.modules[data.module];
    if (mod) {
      const args = data.app ? ['-a', data.app, mod.path] : [mod.path];
      spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
    }
    sendJson(res, { ok: !!mod });
  },
};

// Server có thể chạy lệnh tuỳ ý nên chỉ nhận request từ chính trang này:
// - Host phải là localhost (chống DNS rebinding)
// - POST phải là JSON (buộc trình duyệt preflight CORS) và Origin (nếu có) phải khớp
function isAllowed(req) {
  const hosts = [`127.0.0.1:${ARGS.port}`, `localhost:${ARGS.port}`];
  if (!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.some((h) => origin === `http://${h}`)) return false;
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!isAllowed(req)) return sendJson(res, { error: 'forbidden' }, 403);
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname === '/index.html' ? '/' : url.pathname}`];
  if (!handler) return sendJson(res, { error: 'not found' }, 404);
  try {
    await handler(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, { error: String(e) }, 500);
  }
});

// Dev: sửa index.html -> trình duyệt tự reload (server.js do `node --watch` lo khởi động lại)
function watchUi() {
  let timer;
  fs.watch(path.join(HERE, 'index.html'), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log('[dev] index.html thay đổi -> reload trình duyệt');
      broadcast({ type: 'reload' });
    }, 100);
  });
}

(async () => {
  state.jdks = await listJdks();
  // Dev: không truyền --root thì mở lại folder dùng gần nhất
  const root = ARGS.root || (ARGS.dev && state.saved.recentRoots.find((r) => fs.existsSync(r)));
  if (root) {
    try {
      await setRoot(root);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
  if (ARGS.dev) watchUi();
  server.listen(ARGS.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${ARGS.port}`;
    console.log(`Mvn Dashboard${ARGS.dev ? ' [dev]' : ''}: ${url}` + (state.root
      ? `  (root: ${state.root}, ${Object.keys(state.modules).length} modules)`
      : '  (chọn folder trên giao diện)'));
    if (!ARGS.browser) return;
    const openBrowser = () => spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    // Dev: tab cũ sẽ tự kết nối lại sau khi restart, chỉ mở tab mới nếu chưa có ai kết nối
    if (ARGS.dev) setTimeout(() => state.clients.size || openBrowser(), 2500);
    else openBrowser();
  });
})();

const shutdown = () => {
  cancelAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
