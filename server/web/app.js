const state = { sessions: new Map(), selected: null, ws: null };
const byId = id => document.getElementById(id);

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
    meta.textContent = (session.idle ? "idle" : "running") + " · " + (session.model || "model");
    button.append(title, meta);
    button.onclick = () => { state.selected = session.id; renderSessions(); renderDetail(); };
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

function handle(message) {
  if (message.type === "session.register") state.sessions.set(message.session.id, message.session);
  if (message.type === "session.update") {
    const current = state.sessions.get(message.sessionId);
    if (current) Object.assign(current, message.patch);
  }
  if (message.type === "session.remove") {
    state.sessions.delete(message.sessionId);
    if (state.selected === message.sessionId) state.selected = null;
  }
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
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(proto + "//" + location.host + "/ws/browser");
  state.ws.onopen = () => { byId("connection").textContent = "connected"; };
  state.ws.onclose = () => {
    byId("connection").textContent = "reconnecting";
    setTimeout(connect, 1200);
  };
  state.ws.onmessage = event => handle(JSON.parse(event.data));
}

fetch("/api/sessions").then(r => r.json()).then(({ sessions }) => {
  sessions.forEach(s => state.sessions.set(s.id, s));
  renderSessions();
});

byId("promptForm").onsubmit = event => {
  event.preventDefault();
  const text = byId("prompt").value.trim();
  if (!text) return;
  command({ type: byId("steer").checked ? "steer" : "prompt", text });
  byId("prompt").value = "";
};
byId("abort").onclick = () => command({ type: "abort" });
byId("planRun").onclick = () => command({ type: "plan", text: byId("planText").value });

document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b === button));
  ["activity", "diff", "plan"].forEach(id => { byId(id).hidden = id !== button.dataset.tab; });
  if (button.dataset.tab === "diff") command({ type: "git_diff", staged: false });
});

connect();
