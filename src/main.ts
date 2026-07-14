import { invoke, isTauri } from "@tauri-apps/api/core";

interface NodeOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

type NodeKind = "script" | "condition" | "loop" | "comment";
type Branch = "out" | "true" | "false" | "body" | "done";
type LoopMode = "count" | "foreach";

const AGENT_URL = "http://127.0.0.1:47932";
const TOKEN_KEY = "shellcraft-agent-token";
const AUTOSAVE_KEY = "shellcraft-autosave";
const desktopMode = isTauri();
const MAX_LOOP_ITERATIONS = 1000;

let autosaveTimer: number | undefined;

function scheduleAutosave() {
  if (autosaveTimer !== undefined) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeGraph()));
  }, 400);
}

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
  kind: NodeKind;
  el: HTMLDivElement;
  titleInput: HTMLInputElement;
  scriptEl?: HTMLTextAreaElement;
  loopModeSelect?: HTMLSelectElement;
  loopVarInput?: HTMLInputElement;
  outputEl?: HTMLPreElement;
  inConn?: HTMLDivElement;
  outConns: Partial<Record<Branch, HTMLDivElement>>;
  x: number;
  y: number;
}

interface Edge {
  id: string;
  from: string;
  to: string;
  branch: Branch;
  pathEl: SVGPathElement;
}

interface SavedNode {
  id: string;
  kind?: NodeKind;
  x: number;
  y: number;
  title: string;
  script: string;
  loopMode?: LoopMode;
  loopVar?: string;
}

interface SavedEdge {
  from: string;
  to: string;
  branch?: Branch;
}

interface SavedGraph {
  nodes: SavedNode[];
  edges: SavedEdge[];
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

function edgeColor(branch: Branch): string {
  switch (branch) {
    case "true":
      return "#4ec9b0";
    case "false":
      return "#f14c4c";
    case "body":
      return "#c586c0";
    case "done":
      return "#888888";
    default:
      return "#569cd6";
  }
}

function redrawEdges() {
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to || !to.inConn) continue;
    const outEl = from.outConns[edge.branch];
    if (!outEl) continue;
    const p1 = connCenter(outEl);
    const p2 = connCenter(to.inConn);
    edge.pathEl.setAttribute("d", edgePathD(p1.x, p1.y, p2.x, p2.y));
  }
}

function kindLabel(kind: NodeKind): string {
  switch (kind) {
    case "script":
      return "Blok";
    case "condition":
      return "Warunek";
    case "loop":
      return "Pętla";
    case "comment":
      return "Notatka";
  }
}

function nodeBodyHtml(kind: NodeKind): string {
  switch (kind) {
    case "script":
      return `
        <div class="node-body">
          <textarea class="script" spellcheck="false" placeholder="Get-ChildItem"></textarea>
          <button class="run-node">Uruchom blok</button>
          <pre class="output"></pre>
        </div>`;
    case "condition":
      return `
        <div class="node-body">
          <textarea class="script" spellcheck="false" placeholder="$x -gt 5"></textarea>
          <button class="run-node">Sprawdź warunek</button>
          <pre class="output"></pre>
        </div>`;
    case "loop":
      return `
        <div class="node-body">
          <select class="loop-mode">
            <option value="count">Powtórz N razy</option>
            <option value="foreach">Dla każdego</option>
          </select>
          <textarea class="script" spellcheck="false" placeholder="5   albo   Get-ChildItem *.txt"></textarea>
          <label class="loop-var-label">Zmienna: $<input class="loop-var" /></label>
          <button class="run-node">Podgląd iteracji</button>
          <pre class="output"></pre>
        </div>`;
    case "comment":
      return `
        <div class="node-body">
          <textarea class="script note" spellcheck="false" placeholder="Notatka..."></textarea>
        </div>`;
  }
}

function connectorsHtml(kind: NodeKind): string {
  switch (kind) {
    case "script":
      return '<div class="conn out" data-branch="out" title="Wyjście"></div>';
    case "condition":
      return `
        <div class="conn out out-true" data-branch="true" title="Tak"></div>
        <div class="conn out out-false" data-branch="false" title="Nie"></div>`;
    case "loop":
      return `
        <div class="conn out out-body" data-branch="body" title="Pętla"></div>
        <div class="conn out out-done" data-branch="done" title="Po pętli"></div>`;
    case "comment":
      return "";
  }
}

function createNode(
  x: number,
  y: number,
  kind: NodeKind = "script",
  options?: {
    id?: string;
    title?: string;
    script?: string;
    loopMode?: LoopMode;
    loopVar?: string;
  },
): NodeBlock {
  const id = options?.id ?? makeId("node");
  nodeSeq += 1;

  const el = document.createElement("div");
  el.className = `node node-${kind}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerHTML = `
    <div class="node-header">
      <input class="title" />
      ${kind !== "comment" ? '<button class="run-node-btn" title="Uruchom">▶</button>' : ""}
      <button class="del-node-btn" title="Usuń">✕</button>
    </div>
    ${nodeBodyHtml(kind)}
    ${kind !== "comment" ? '<div class="conn in" title="Wejście"></div>' : ""}
    ${connectorsHtml(kind)}
  `;
  nodesLayer.appendChild(el);

  const titleInput = el.querySelector<HTMLInputElement>("input.title")!;
  titleInput.value = options?.title ?? `${kindLabel(kind)} ${nodeSeq}`;

  const scriptEl = el.querySelector<HTMLTextAreaElement>("textarea.script") ?? undefined;
  if (scriptEl) scriptEl.value = options?.script ?? "";

  const outputEl = el.querySelector<HTMLPreElement>("pre.output") ?? undefined;
  const inConn = el.querySelector<HTMLDivElement>(".conn.in") ?? undefined;

  const outConns: Partial<Record<Branch, HTMLDivElement>> = {};
  el.querySelectorAll<HTMLDivElement>(".conn.out").forEach((connEl) => {
    const branch = (connEl.dataset.branch as Branch) ?? "out";
    outConns[branch] = connEl;
  });

  const loopModeSelect = el.querySelector<HTMLSelectElement>("select.loop-mode") ?? undefined;
  if (loopModeSelect) loopModeSelect.value = options?.loopMode ?? "count";
  const loopVarInput = el.querySelector<HTMLInputElement>("input.loop-var") ?? undefined;
  if (loopVarInput) loopVarInput.value = options?.loopVar ?? "i";

  const header = el.querySelector<HTMLDivElement>(".node-header")!;
  const delBtn = el.querySelector<HTMLButtonElement>(".del-node-btn")!;
  const runBtns = el.querySelectorAll<HTMLButtonElement>(".run-node, .run-node-btn");

  const node: NodeBlock = {
    id,
    kind,
    el,
    titleInput,
    scriptEl,
    loopModeSelect,
    loopVarInput,
    outputEl,
    inConn,
    outConns,
    x,
    y,
  };
  nodes.set(id, node);

  for (const [branch, connEl] of Object.entries(outConns)) {
    connEl.addEventListener("mousedown", (e) => startConnectorDrag(e, node, branch as Branch));
  }

  header.addEventListener("mousedown", (e) => startNodeDrag(e, node));
  runBtns.forEach((btn) => btn.addEventListener("click", () => void runNodePreview(node)));
  delBtn.addEventListener("click", () => deleteNode(node.id));

  titleInput.addEventListener("input", scheduleAutosave);
  scriptEl?.addEventListener("input", scheduleAutosave);
  loopModeSelect?.addEventListener("change", scheduleAutosave);
  loopVarInput?.addEventListener("input", scheduleAutosave);

  const observer = new ResizeObserver(() => redrawEdges());
  observer.observe(el);

  scheduleAutosave();
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
  scheduleAutosave();
}

function startNodeDrag(e: MouseEvent, node: NodeBlock) {
  const target = e.target as HTMLElement;
  if (target.closest("input, button, select")) return;
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
    scheduleAutosave();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startConnectorDrag(e: MouseEvent, fromNode: NodeBlock, branch: Branch) {
  e.preventDefault();
  e.stopPropagation();

  const fromEl = fromNode.outConns[branch];
  if (!fromEl) return;

  const temp = document.createElementNS("http://www.w3.org/2000/svg", "path");
  temp.setAttribute("class", "edge");
  temp.setAttribute("stroke", edgeColor(branch));
  temp.setAttribute("stroke-dasharray", "4 3");
  temp.setAttribute("fill", "none");
  temp.setAttribute("stroke-width", "2");
  edgesLayer.appendChild(temp);

  function onMove(ev: MouseEvent) {
    const p1 = connCenter(fromEl!);
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
      if (targetNode && targetNode.id !== fromNode.id && targetNode.inConn) {
        addEdge(fromNode.id, targetNode.id, branch);
      }
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function addEdge(fromId: string, toId: string, branch: Branch = "out") {
  const exists = edges.some((e) => e.from === fromId && e.to === toId && e.branch === branch);
  if (exists) return;

  const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathEl.setAttribute("class", "edge");
  pathEl.setAttribute("stroke", edgeColor(branch));
  pathEl.setAttribute("stroke-width", "2");
  pathEl.setAttribute("fill", "none");
  edgesLayer.appendChild(pathEl);

  const edge: Edge = { id: makeId("edge"), from: fromId, to: toId, branch, pathEl };
  pathEl.addEventListener("click", () => removeEdge(edge.id));
  edges.push(edge);
  redrawEdges();
  scheduleAutosave();
}

function removeEdge(id: string) {
  const idx = edges.findIndex((e) => e.id === id);
  if (idx === -1) return;
  edges[idx].pathEl.remove();
  edges.splice(idx, 1);
  scheduleAutosave();
}

function hasCycle(): boolean {
  const inDegree = new Map<string, number>();
  for (const id of nodes.keys()) inDegree.set(id, 0);
  for (const edge of edges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);

  const queue: string[] = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visitedCount = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    visitedCount += 1;
    for (const edge of edges.filter((e) => e.from === id)) {
      const d = (inDegree.get(edge.to) ?? 0) - 1;
      inDegree.set(edge.to, d);
      if (d === 0) queue.push(edge.to);
    }
  }

  return visitedCount !== nodes.size;
}

async function runScriptNode(node: NodeBlock) {
  node.el.classList.remove("ok", "error");
  node.el.classList.add("running");
  node.outputEl!.textContent = "…";
  try {
    const result = await executeScript(node.scriptEl!.value);
    node.el.classList.remove("running");
    const ok = result.code === 0 || result.code === null;
    node.el.classList.add(ok ? "ok" : "error");
    node.outputEl!.innerHTML = "";
    if (result.stdout.trim()) {
      node.outputEl!.appendChild(document.createTextNode(result.stdout.trimEnd()));
    }
    if (result.stderr.trim()) {
      const span = document.createElement("span");
      span.className = "stderr";
      span.textContent = (result.stdout.trim() ? "\n" : "") + result.stderr.trimEnd();
      node.outputEl!.appendChild(span);
    }
    if (!result.stdout.trim() && !result.stderr.trim()) {
      node.outputEl!.textContent = `(brak wyjścia, kod: ${result.code ?? "?"})`;
    }
  } catch (err) {
    node.el.classList.remove("running");
    node.el.classList.add("error");
    node.outputEl!.textContent = String(err);
  }
}

async function evalCondition(node: NodeBlock): Promise<boolean> {
  node.el.classList.remove("ok", "error");
  node.el.classList.add("running");
  node.outputEl!.textContent = "…";
  const expr = node.scriptEl?.value ?? "";
  const wrapped = `if (${expr}) { Write-Output "SHELLCRAFT_TRUE" } else { Write-Output "SHELLCRAFT_FALSE" }`;
  try {
    const result = await executeScript(wrapped);
    const isTrue = /SHELLCRAFT_TRUE/.test(result.stdout);
    node.el.classList.remove("running");
    node.el.classList.add(isTrue ? "ok" : "error");
    node.outputEl!.textContent = isTrue ? "✓ TAK" : "✗ NIE";
    return isTrue;
  } catch (err) {
    node.el.classList.remove("running");
    node.el.classList.add("error");
    node.outputEl!.textContent = String(err);
    throw err;
  }
}

async function resolveLoopItemsRaw(node: NodeBlock): Promise<string[]> {
  const mode = (node.loopModeSelect?.value as LoopMode) ?? "count";
  const expr = node.scriptEl?.value ?? "";

  if (mode === "count") {
    const result = await executeScript(`Write-Output (${expr})`);
    const n = parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Nieprawidłowa liczba iteracji: "${result.stdout.trim()}"`);
    }
    if (n > MAX_LOOP_ITERATIONS) {
      throw new Error(`Zbyt wiele iteracji (${n}), limit to ${MAX_LOOP_ITERATIONS}.`);
    }
    return Array.from({ length: n }, (_, i) => String(i));
  }

  const result = await executeScript(`${expr} | ForEach-Object { Write-Output $_ }`);
  const items = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (items.length > MAX_LOOP_ITERATIONS) {
    throw new Error(`Zbyt wiele iteracji (${items.length}), limit to ${MAX_LOOP_ITERATIONS}.`);
  }
  return items;
}

async function resolveLoopItems(node: NodeBlock): Promise<string[]> {
  node.el.classList.remove("ok", "error");
  node.el.classList.add("running");
  node.outputEl!.textContent = "…";
  try {
    const items = await resolveLoopItemsRaw(node);
    node.el.classList.remove("running");
    node.el.classList.add("ok");
    node.outputEl!.textContent = `${items.length} iteracji: ${items.slice(0, 20).join(", ")}${items.length > 20 ? "…" : ""}`;
    return items;
  } catch (err) {
    node.el.classList.remove("running");
    node.el.classList.add("error");
    node.outputEl!.textContent = String(err);
    throw err;
  }
}

async function runNodePreview(node: NodeBlock) {
  try {
    switch (node.kind) {
      case "script":
        await runScriptNode(node);
        break;
      case "condition":
        await evalCondition(node);
        break;
      case "loop":
        await resolveLoopItems(node);
        break;
      case "comment":
        break;
    }
  } catch {
    // błąd już wyświetlony w treści węzła
  }
}

async function continueTo(
  nodeId: string,
  branch: Branch,
  executed: Set<string>,
  callStack: Set<string>,
): Promise<void> {
  for (const edge of edges.filter((e) => e.from === nodeId && e.branch === branch)) {
    await runFrom(edge.to, executed, callStack);
  }
}

async function runFrom(nodeId: string, executed: Set<string>, callStack: Set<string>): Promise<void> {
  if (executed.has(nodeId)) return;
  if (callStack.has(nodeId)) {
    throw new Error("Wykryto nieoczekiwany cykl podczas wykonania grafu.");
  }
  const node = nodes.get(nodeId);
  if (!node) return;

  callStack.add(nodeId);
  executed.add(nodeId);

  if (node.kind === "script") {
    await runScriptNode(node);
    await continueTo(nodeId, "out", executed, callStack);
  } else if (node.kind === "condition") {
    const isTrue = await evalCondition(node);
    await continueTo(nodeId, isTrue ? "true" : "false", executed, callStack);
  } else if (node.kind === "loop") {
    const varName = node.loopVarInput?.value.trim() || "i";
    const items = await resolveLoopItems(node);
    for (const item of items) {
      await executeScript(`$${varName} = '${item.replace(/'/g, "''")}'`);
      const bodyExecuted = new Set<string>();
      await continueTo(nodeId, "body", bodyExecuted, callStack);
    }
    await continueTo(nodeId, "done", executed, callStack);
  }

  callStack.delete(nodeId);
}

async function runGraph() {
  if (hasCycle()) {
    alert("Wykryto cykl w grafie — nie można uruchomić.");
    return;
  }

  const hasIncoming = new Set(edges.map((e) => e.to));
  const roots = [...nodes.keys()].filter((id) => !hasIncoming.has(id) && nodes.get(id)!.kind !== "comment");

  const executed = new Set<string>();
  const callStack = new Set<string>();
  for (const rootId of roots) {
    try {
      await runFrom(rootId, executed, callStack);
    } catch {
      // błąd już wyświetlony na węźle, który go wyrzucił — przechodzimy do kolejnego korzenia
    }
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
      kind: n.kind,
      x: n.x,
      y: n.y,
      title: n.titleInput.value,
      script: n.scriptEl?.value ?? "",
      loopMode: n.loopModeSelect?.value as LoopMode | undefined,
      loopVar: n.loopVarInput?.value,
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, branch: e.branch })),
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
    createNode(n.x, n.y, n.kind ?? "script", {
      id: n.id,
      title: n.title,
      script: n.script,
      loopMode: n.loopMode,
      loopVar: n.loopVar,
    });
  }
  for (const e of data.edges) {
    if (nodes.has(e.from) && nodes.has(e.to)) addEdge(e.from, e.to, e.branch ?? "out");
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

function addNodeAt(kind: NodeKind) {
  const scroll = { left: canvasWrap.scrollLeft, top: canvasWrap.scrollTop };
  createNode(60 + scroll.left + (nodes.size % 5) * 20, 60 + scroll.top + (nodes.size % 5) * 20, kind);
}

window.addEventListener("resize", redrawEdges);

document.querySelector("#add-script")?.addEventListener("click", () => addNodeAt("script"));
document.querySelector("#add-condition")?.addEventListener("click", () => addNodeAt("condition"));
document.querySelector("#add-loop")?.addEventListener("click", () => addNodeAt("loop"));
document.querySelector("#add-comment")?.addEventListener("click", () => addNodeAt("comment"));
document.querySelector("#run-all")?.addEventListener("click", () => void runGraph());
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

function loadAutosaveOrDefault() {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (raw) {
    try {
      const data = JSON.parse(raw) as SavedGraph;
      if (Array.isArray(data.nodes) && Array.isArray(data.edges) && data.nodes.length > 0) {
        loadGraph(data);
        return;
      }
    } catch {
      // uszkodzony autozapis — ignorujemy i wracamy do domyślnego stanu
    }
  }
  createNode(60, 60, "script", { script: "Get-Date" });
}

setupAgentPanel();
loadAutosaveOrDefault();
