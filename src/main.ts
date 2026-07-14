import { invoke, isTauri } from "@tauri-apps/api/core";

interface NodeOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

const AGENT_URL = "http://127.0.0.1:47932";
const TOKEN_KEY = "shellcraft-agent-token";
const desktopMode = isTauri();

function getAgentToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

function setAgentToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

async function checkAgentHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL}/health`, {
      headers: { "X-ShellCraft-Token": getAgentToken() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runViaAgent(script: string): Promise<NodeOutput> {
  const res = await fetch(`${AGENT_URL}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ShellCraft-Token": getAgentToken(),
    },
    body: JSON.stringify({ script }),
  });
  if (res.status === 401) {
    throw new Error("Zły lub brak tokenu agenta. Wklej poprawny token w panelu \"Połącz z agentem\".");
  }
  if (!res.ok) {
    throw new Error(`Agent zwrócił błąd HTTP ${res.status}`);
  }
  return (await res.json()) as NodeOutput;
}

async function executeScript(script: string): Promise<NodeOutput> {
  if (desktopMode) {
    return invoke<NodeOutput>("run_node", { script });
  }
  return runViaAgent(script);
}

async function restartSession(): Promise<void> {
  if (desktopMode) {
    await invoke("restart_session");
    return;
  }
  const res = await fetch(`${AGENT_URL}/restart`, {
    method: "POST",
    headers: { "X-ShellCraft-Token": getAgentToken() },
  });
  if (!res.ok) {
    throw new Error(`Agent zwrócił błąd HTTP ${res.status}`);
  }
}

interface NodeBlock {
  id: string;
  el: HTMLDivElement;
  titleInput: HTMLInputElement;
  scriptEl: HTMLTextAreaElement;
  outputEl: HTMLPreElement;
  outConn: HTMLDivElement;
  inConn: HTMLDivElement;
  x: number;
  y: number;
}

interface SavedGraph {
  nodes: { id: string; x: number; y: number; title: string; script: string }[];
  edges: { from: string; to: string }[];
}

interface Edge {
  id: string;
  from: string;
  to: string;
  pathEl: SVGPathElement;
}

const nodes = new Map<string, NodeBlock>();
const edges: Edge[] = [];
let nodeSeq = 0;

const canvasWrap = document.querySelector<HTMLDivElement>("#canvas-wrap")!;
const nodesLayer = document.querySelector<HTMLDivElement>("#nodes-layer")!;
const edgesLayer = document.querySelector<SVGSVGElement>("#edges-layer")!;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function localPoint(clientX: number, clientY: number) {
  const rect = nodesLayer.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function connCenter(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const wrapRect = nodesLayer.getBoundingClientRect();
  return { x: r.left + r.width / 2 - wrapRect.left, y: r.top + r.height / 2 - wrapRect.top };
}

function edgePathD(x1: number, y1: number, x2: number, y2: number): string {
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function redrawEdges() {
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    const p1 = connCenter(from.outConn);
    const p2 = connCenter(to.inConn);
    edge.pathEl.setAttribute("d", edgePathD(p1.x, p1.y, p2.x, p2.y));
  }
}

function createNode(
  x: number,
  y: number,
  initialScript = "",
  options?: { id?: string; title?: string },
): NodeBlock {
  const id = options?.id ?? makeId("node");
  nodeSeq += 1;

  const el = document.createElement("div");
  el.className = "node";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerHTML = `
    <div class="node-header">
      <input class="title" />
      <button class="run-node-btn" title="Uruchom">▶</button>
      <button class="del-node-btn" title="Usuń">✕</button>
    </div>
    <div class="node-body">
      <textarea class="script" spellcheck="false" placeholder="Get-ChildItem"></textarea>
      <button class="run-node">Uruchom blok</button>
      <pre class="output"></pre>
    </div>
    <div class="conn in" title="Wejście"></div>
    <div class="conn out" title="Wyjście"></div>
  `;
  nodesLayer.appendChild(el);

  const titleInput = el.querySelector<HTMLInputElement>("input.title")!;
  titleInput.value = options?.title ?? `Blok ${nodeSeq}`;
  const scriptEl = el.querySelector<HTMLTextAreaElement>("textarea.script")!;
  scriptEl.value = initialScript;
  const outputEl = el.querySelector<HTMLPreElement>("pre.output")!;
  const outConn = el.querySelector<HTMLDivElement>(".conn.out")!;
  const inConn = el.querySelector<HTMLDivElement>(".conn.in")!;
  const header = el.querySelector<HTMLDivElement>(".node-header")!;
  const runBtns = el.querySelectorAll<HTMLButtonElement>(".run-node, .run-node-btn");
  const delBtn = el.querySelector<HTMLButtonElement>(".del-node-btn")!;

  const node: NodeBlock = { id, el, titleInput, scriptEl, outputEl, outConn, inConn, x, y };
  nodes.set(id, node);

  header.addEventListener("mousedown", (e) => startNodeDrag(e, node));
  outConn.addEventListener("mousedown", (e) => startConnectorDrag(e, node));
  runBtns.forEach((btn) => btn.addEventListener("click", () => runNode(node)));
  delBtn.addEventListener("click", () => deleteNode(node.id));

  const observer = new ResizeObserver(() => redrawEdges());
  observer.observe(el);

  return node;
}

function deleteNode(id: string) {
  const node = nodes.get(id);
  if (!node) return;
  for (const edge of [...edges]) {
    if (edge.from === id || edge.to === id) removeEdge(edge.id);
  }
  node.el.remove();
  nodes.delete(id);
}

function startNodeDrag(e: MouseEvent, node: NodeBlock) {
  const target = e.target as HTMLElement;
  if (target.closest("input, button")) return;
  e.preventDefault();

  const start = localPoint(e.clientX, e.clientY);
  const offsetX = start.x - node.x;
  const offsetY = start.y - node.y;

  function onMove(ev: MouseEvent) {
    const p = localPoint(ev.clientX, ev.clientY);
    node.x = Math.max(0, p.x - offsetX);
    node.y = Math.max(0, p.y - offsetY);
    node.el.style.left = `${node.x}px`;
    node.el.style.top = `${node.y}px`;
    redrawEdges();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startConnectorDrag(e: MouseEvent, fromNode: NodeBlock) {
  e.preventDefault();
  e.stopPropagation();

  const temp = document.createElementNS("http://www.w3.org/2000/svg", "path");
  temp.setAttribute("class", "edge");
  temp.setAttribute("stroke", "#4ec9b0");
  temp.setAttribute("stroke-dasharray", "4 3");
  temp.setAttribute("fill", "none");
  temp.setAttribute("stroke-width", "2");
  edgesLayer.appendChild(temp);

  function onMove(ev: MouseEvent) {
    const p1 = connCenter(fromNode.outConn);
    const p2 = localPoint(ev.clientX, ev.clientY);
    temp.setAttribute("d", edgePathD(p1.x, p1.y, p2.x, p2.y));
  }

  function onUp(ev: MouseEvent) {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    temp.remove();

    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const inConn = el?.closest<HTMLElement>(".conn.in");
    if (inConn) {
      const targetEl = inConn.closest<HTMLDivElement>(".node");
      const targetNode = [...nodes.values()].find((n) => n.el === targetEl);
      if (targetNode && targetNode.id !== fromNode.id) {
        addEdge(fromNode.id, targetNode.id);
      }
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function addEdge(fromId: string, toId: string) {
  const exists = edges.some((e) => e.from === fromId && e.to === toId);
  if (exists) return;

  const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathEl.setAttribute("class", "edge");
  pathEl.setAttribute("stroke", "#569cd6");
  pathEl.setAttribute("stroke-width", "2");
  pathEl.setAttribute("fill", "none");
  edgesLayer.appendChild(pathEl);

  const edge: Edge = { id: makeId("edge"), from: fromId, to: toId, pathEl };
  pathEl.addEventListener("click", () => removeEdge(edge.id));
  edges.push(edge);
  redrawEdges();
}

function removeEdge(id: string) {
  const idx = edges.findIndex((e) => e.id === id);
  if (idx === -1) return;
  edges[idx].pathEl.remove();
  edges.splice(idx, 1);
}

function topoSort(): string[] | null {
  const inDegree = new Map<string, number>();
  for (const id of nodes.keys()) inDegree.set(id, 0);
  for (const edge of edges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);

  const queue: string[] = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of edges.filter((e) => e.from === id)) {
      const d = (inDegree.get(edge.to) ?? 0) - 1;
      inDegree.set(edge.to, d);
      if (d === 0) queue.push(edge.to);
    }
  }

  return order.length === nodes.size ? order : null;
}

async function runNode(node: NodeBlock) {
  node.el.classList.remove("ok", "error");
  node.el.classList.add("running");
  node.outputEl.textContent = "…";
  try {
    const result = await executeScript(node.scriptEl.value);
    node.el.classList.remove("running");
    const ok = result.code === 0 || result.code === null;
    node.el.classList.add(ok ? "ok" : "error");
    node.outputEl.innerHTML = "";
    if (result.stdout.trim()) {
      node.outputEl.appendChild(document.createTextNode(result.stdout.trimEnd()));
    }
    if (result.stderr.trim()) {
      const span = document.createElement("span");
      span.className = "stderr";
      span.textContent = (result.stdout.trim() ? "\n" : "") + result.stderr.trimEnd();
      node.outputEl.appendChild(span);
    }
    if (!result.stdout.trim() && !result.stderr.trim()) {
      node.outputEl.textContent = `(brak wyjścia, kod: ${result.code ?? "?"})`;
    }
  } catch (err) {
    node.el.classList.remove("running");
    node.el.classList.add("error");
    node.outputEl.textContent = String(err);
  }
}

async function runAll() {
  const order = topoSort();
  if (!order) {
    alert("Wykryto cykl w grafie — nie można uruchomić.");
    return;
  }
  for (const id of order) {
    const node = nodes.get(id);
    if (node) await runNode(node);
  }
}

function clearAll() {
  if (nodes.size === 0) return;
  if (!confirm("Usunąć wszystkie bloki i połączenia?")) return;
  for (const id of [...nodes.keys()]) deleteNode(id);
}

function serializeGraph(): SavedGraph {
  return {
    nodes: [...nodes.values()].map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      title: n.titleInput.value,
      script: n.scriptEl.value,
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

function saveGraph() {
  const json = JSON.stringify(serializeGraph(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shellcraft-graph.json";
  a.click();
  URL.revokeObjectURL(url);
}

function loadGraph(data: SavedGraph) {
  for (const id of [...nodes.keys()]) deleteNode(id);

  for (const n of data.nodes) {
    createNode(n.x, n.y, n.script, { id: n.id, title: n.title });
  }
  for (const e of data.edges) {
    if (nodes.has(e.from) && nodes.has(e.to)) addEdge(e.from, e.to);
  }
  redrawEdges();
}

async function loadGraphFromFile(file: File) {
  let data: SavedGraph;
  try {
    const text = await file.text();
    data = JSON.parse(text);
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error("Nieprawidłowa struktura pliku.");
    }
  } catch (err) {
    alert(`Nie udało się wczytać grafu: ${String(err)}`);
    return;
  }
  if (nodes.size > 0 && !confirm("Wczytanie grafu zastąpi obecne bloki i połączenia. Kontynuować?")) {
    return;
  }
  loadGraph(data);
}

function setupAgentPanel() {
  const hintEl = document.querySelector<HTMLSpanElement>("#hint")!;
  if (desktopMode) {
    hintEl.textContent =
      "Przeciągnij z kropki wyjścia (prawa) do kropki wejścia (lewa) innego bloku, aby połączyć. Kliknij linię, aby ją usunąć.";
    return;
  }

  hintEl.textContent =
    "Tryb przeglądarki: wymaga lokalnie uruchomionego agenta ShellCraft. Wklej token pokazany w konsoli agenta i kliknij \"Sprawdź połączenie\".";

  const panel = document.querySelector<HTMLDivElement>("#agent-panel")!;
  const tokenInput = document.querySelector<HTMLInputElement>("#agent-token")!;
  const statusEl = document.querySelector<HTMLSpanElement>("#agent-status")!;
  const checkBtn = document.querySelector<HTMLButtonElement>("#agent-check")!;

  panel.classList.add("visible");
  tokenInput.value = getAgentToken();

  async function refreshStatus() {
    statusEl.classList.remove("ok", "error");
    const healthy = await checkAgentHealth();
    statusEl.classList.add(healthy ? "ok" : "error");
    statusEl.title = healthy
      ? "Połączono z agentem"
      : "Brak połączenia z agentem (sprawdź, czy działa i czy token jest poprawny)";
  }

  tokenInput.addEventListener("change", () => setAgentToken(tokenInput.value.trim()));
  checkBtn.addEventListener("click", () => {
    setAgentToken(tokenInput.value.trim());
    void refreshStatus();
  });

  if (getAgentToken()) void refreshStatus();
}

window.addEventListener("resize", redrawEdges);

document.querySelector("#add-node")?.addEventListener("click", () => {
  const scroll = { left: canvasWrap.scrollLeft, top: canvasWrap.scrollTop };
  createNode(60 + scroll.left + (nodes.size % 5) * 20, 60 + scroll.top + (nodes.size % 5) * 20);
});
document.querySelector("#run-all")?.addEventListener("click", () => void runAll());
document.querySelector("#clear-all")?.addEventListener("click", clearAll);
document.querySelector("#restart-session")?.addEventListener("click", () => {
  if (!confirm("Zrestartować sesję PowerShell? Wszystkie zmienne zostaną utracone.")) return;
  void restartSession().catch((err) => alert(String(err)));
});
document.querySelector("#save-graph")?.addEventListener("click", saveGraph);
const loadInput = document.querySelector<HTMLInputElement>("#load-graph-input")!;
document.querySelector("#load-graph")?.addEventListener("click", () => loadInput.click());
loadInput.addEventListener("change", () => {
  const file = loadInput.files?.[0];
  if (file) void loadGraphFromFile(file);
  loadInput.value = "";
});

setupAgentPanel();
createNode(60, 60, "Get-Date");
