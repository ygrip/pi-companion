const remoteMode = document.body.dataset.remote === "true";
const state = {
  sessions: new Map(),
  files: new Map(),
  selected: null,
  ws: null,
  token: localStorage.getItem("piCompanionDeviceToken")
};
const byId = id => document.getElementById(id);

function withToken(path) {
  if (!remoteMode || !state.token) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(state.token);
}

async function api(path, options) {
  const response = await fetch(withToken(path), options);
  if (!response.ok) throw new Error((await response.text()) || response.statusText);
  if (response.status === 204) return null;
  return response.json();
}

function command(command) {
  if (!state.selected || state.ws?.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ sessionId: state.selected, command }));
}

function renderSessions() {
  const host = byId("sessions");
  host.innerHTML = "";
  for (const session of state.sessions.values()) {
    const button = document.createElement("button");
    button.className = "session" + (session.id === state.selected ? " active" : "");
    const title = document.createElement("strong");
    title.textContent = session.name || session.cwd.split("/").pop() || "Pi";
    const meta = document.createElement("span");
    meta.textContent = (session.idle ? "idle" : "running") + " · " + (session.model || "model") + (session.remoteEnabled ? " · remote" : "");
    button.append(title, meta);
    button.onclick = () => {
      state.selected = session.id;
      renderSessions();
      renderDetail();
      void loadFiles();
    };
    host.appendChild(button);
  }
}

function renderDetail() {
  const session = state.sessions.get(state.selected);
  byId("empty").hidden = Boolean(session);
  byId("detail").hidden = !session;
  if (!session) return;
  byId("title").textContent = session.name || session.cwd;
  byId("meta").textContent = session.cwd + " · pid " + session.pid;
  byId("remoteState").textContent = session.remoteEnabled ? "remote enabled" : "local only";
}

function append(text) {
  const activity = byId("activity");
  activity.textContent += text + "\n";
  activity.scrollTop = activity.scrollHeight;
}

function renderAsk(req) {
  const host = byId("ask");
  host.hidden = false;
  host.innerHTML = "";
  const question = document.createElement("strong");
  question.textContent = req.question;
  const options = document.createElement("div");
  options.className = "ask-options";
  for (const option of req.options?.length ? req.options : ["Continue"]) {
    const button = document.createElement("button");
    button.textContent = option;
    button.onclick = () => {
      command({ type: "ask_answer", requestId: req.requestId, answer: option });
      host.hidden = true;
    };
    options.appendChild(button);
  }
  host.append(question, options);
}

function renderFiles() {
  const host = byId("fileList");
  host.innerHTML = "";
  const files = state.files.get(state.selected) || [];
  if (!files.length) {
    host.textContent = "No temporary files.";
    return;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.textContent = formatBytes(file.size);
    info.append(name, meta);
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.onclick = async () => {
      await api("/api/sessions/" + encodeURIComponent(state.selected) + "/files/" + encodeURIComponent(file.id), { method: "DELETE" });
      await loadFiles();
    };
    row.append(info, remove);
    host.appendChild(row);
  }
}

async function loadFiles() {
  if (!state.selected) return;
  try {
    const result = await api("/api/sessions/" + encodeURIComponent(state.selected) + "/files");
    state.files.set(state.selected, result.files);
    renderFiles();
  } catch (error) {
    append("files: " + error.message);
  }
}

async function loadDevices() {
  if (remoteMode) return;
  const result = await api("/api/devices");
  const host = byId("devices");
  host.innerHTML = "";
  if (!result.devices.length) {
    host.textContent = "No paired devices.";
    return;
  }
  for (const device of result.devices) {
    const row = document.createElement("div");
    row.className = "device-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = device.name;
    const seen = document.createElement("span");
    seen.textContent = "last seen " + new Date(device.lastSeen * 1000).toLocaleString();
    info.append(name, seen);
    const revoke = document.createElement("button");
    revoke.className = "danger";
    revoke.textContent = "Revoke";
    revoke.onclick = async () => {
      await api("/api/devices/" + encodeURIComponent(device.id), { method: "DELETE" });
      await loadDevices();
    };
    row.append(info, revoke);
    host.appendChild(row);
  }
}

function handle(message) {
  if (message.type === "session.register") {
    if (!remoteMode || message.session.remoteEnabled) state.sessions.set(message.session.id, message.session);
  }
  if (message.type === "session.update") {
    const current = state.sessions.get(message.sessionId);
    if (current) {
      Object.assign(current, message.patch);
      if (remoteMode && !current.remoteEnabled) {
        state.sessions.delete(message.sessionId);
        if (state.selected === message.sessionId) state.selected = null;
      }
    }
  }
  if (message.type === "session.remove") {
    state.sessions.delete(message.sessionId);
    if (state.selected === message.sessionId) state.selected = null;
  }
  if (message.type === "files.update") {
    state.files.set(message.sessionId, message.files);
    if (message.sessionId === state.selected) renderFiles();
  }
  if (message.type === "devices.update" && !remoteMode) void loadDevices();
  if (message.type === "bridge.event" && message.sessionId === state.selected) {
    const inner = message.message;
    if (inner.type === "git.diff") byId("diff").textContent = inner.diff || "(clean)";
    else if (inner.type === "ask.request") renderAsk(inner);
    else append(JSON.stringify(inner, null, 2));
  }
  renderSessions();
  renderDetail();
}

function connect() {
  if (remoteMode && !state.token) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const suffix = remoteMode ? "?token=" + encodeURIComponent(state.token) : "";
  state.ws = new WebSocket(proto + "//" + location.host + "/ws/browser" + suffix);
  state.ws.onopen = () => { byId("connection").textContent = remoteMode ? "paired" : "connected"; };
  state.ws.onclose = () => {
    byId("connection").textContent = "reconnecting";
    setTimeout(connect, 1200);
  };
  state.ws.onmessage = event => handle(JSON.parse(event.data));
}

async function boot() {
  const invite = new URLSearchParams(location.search).get("invite");
  if (remoteMode && invite && !state.token) {
    byId("app").hidden = true;
    byId("pairClaim").hidden = false;
    byId("deviceName").value = navigator.userAgent.includes("Mobile") ? "Phone" : "Browser";
    byId("claimPair").onclick = async () => {
      try {
        const result = await fetch("/api/pairing/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invite, deviceName: byId("deviceName").value })
        });
        if (!result.ok) throw new Error(await result.text());
        const claimed = await result.json();
        localStorage.setItem("piCompanionDeviceToken", claimed.token);
        location.replace("/");
      } catch (error) {
        byId("pairError").textContent = error.message;
      }
    };
    return;
  }

  if (remoteMode && !state.token) {
    byId("app").hidden = true;
    byId("pairClaim").hidden = false;
    byId("pairClaim").innerHTML = "<h2>Device is not paired</h2><p>Scan a fresh pairing QR from the local Pi Companion dashboard.</p>";
    return;
  }

  if (remoteMode) byId("adminPanel").hidden = true;
  const result = await api("/api/sessions");
  result.sessions.forEach(session => state.sessions.set(session.id, session));
  renderSessions();
  if (!remoteMode) await loadDevices();
  connect();
}

byId("promptForm").onsubmit = event => {
  event.preventDefault();
  const text = byId("prompt").value.trim();
  if (!text) return;
  command({ type: byId("steer").checked ? "steer" : "prompt", text });
  byId("prompt").value = "";
};

byId("uploadForm").onsubmit = async event => {
  event.preventDefault();
  if (!state.selected || !byId("uploadInput").files.length) return;
  const data = new FormData();
  data.append("file", byId("uploadInput").files[0]);
  try {
    await api("/api/sessions/" + encodeURIComponent(state.selected) + "/files", { method: "POST", body: data });
    byId("uploadInput").value = "";
    await loadFiles();
  } catch (error) {
    append("upload: " + error.message);
  }
};

byId("startPairing").onclick = async () => {
  const result = await api("/api/pairing/start", { method: "POST" });
  byId("pairingInvite").hidden = false;
  byId("pairQr").innerHTML = result.qrSvg;
  byId("pairCode").textContent = result.code;
  byId("pairUrl").textContent = result.url;
};

byId("abort").onclick = () => command({ type: "abort" });
byId("planRun").onclick = () => command({ type: "plan", text: byId("planText").value });

document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b === button));
  ["activity", "files", "diff", "plan"].forEach(id => { byId(id).hidden = id !== button.dataset.tab; });
  if (button.dataset.tab === "files") void loadFiles();
  if (button.dataset.tab === "diff") command({ type: "git_diff", staged: false });
});

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / 1024 / 1024).toFixed(1) + " MiB";
}

void boot();
