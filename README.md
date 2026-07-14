# ShellCraft
Node‑Based PowerShell Console Integration, ShellCraft serves as the core engine for future UI layers, enabling advanced OSINT tooling, automation, and interactive scripting.

Concept pictures
<img width="1919" height="1199" alt="image" src="https://github.com/user-attachments/assets/69c114fd-93df-4c21-814f-02980f42e710" />

<img width="1919" height="1199" alt="image" src="https://github.com/user-attachments/assets/146da397-51b0-4ac8-b632-83af70822d6b" />

## Stack

- **Tauri 2 (Rust)** — backend, uruchamia bloki jako procesy `powershell.exe`
- **Vite + TypeScript (vanilla)** — frontend, edytor blokowo-węzłowy (canvas, drag & drop, połączenia SVG)

## Uruchomienie (dev)

```bash
npm install
npm run tauri dev
```

## Jak to działa

- Każdy blok to niezależne wywołanie `powershell.exe -NonInteractive -Command <script>` (komenda Rust `run_node` w [src-tauri/src/lib.rs](src-tauri/src/lib.rs)).
- Bloki łączy się przeciągając z kropki wyjścia (prawa, zielona) do kropki wejścia (lewa, niebieska) innego bloku — połączenia definiują kolejność wykonania w trybie "Uruchom graf" (sortowanie topologiczne, wykrywanie cykli).
- Kliknięcie na linię połączenia usuwa je.

## Tryb web (przeglądarka + lokalny agent)

Ten sam edytor jest też dostępny pod https://michalstankiewicz4-cell.github.io/ShellCraft/ — statyczna strona hostowana na GitHub Pages. Przeglądarka **nie może** sama uruchamiać PowerShell na Twoim komputerze (to celowe ograniczenie bezpieczeństwa), więc strona łączy się z lokalnie uruchomionym agentem przez `http://127.0.0.1:47932`.

Uruchomienie agenta lokalnie:

```bash
cd src-tauri
cargo run --release --bin agent
```

Agent przy starcie wypisze w konsoli token (zapisywany trwale w `%APPDATA%\ShellCraft\agent_token.txt`, więc wystarczy wkleić go raz). Otwórz stronę, wklej token w polu "Token agenta" w pasku narzędzi i kliknij "Sprawdź połączenie".

**Model bezpieczeństwa:**
- Agent nasłuchuje wyłącznie na `127.0.0.1` (niedostępny z sieci).
- Każde żądanie do `/run` wymaga poprawnego tokenu w nagłówku `X-ShellCraft-Token` — bez niego dowolna otwarta karta przeglądarki mogłaby próbować wysyłać komendy do agenta.
- CORS ograniczony do konkretnych originów (strona GitHub Pages oraz `localhost:1420` na potrzeby `npm run dev`) — inne strony nie dostaną odpowiedzi nawet ze złym tokenem.
- To narzędzie deweloperskie dla jednego użytkownika na jego własnej maszynie, nie usługa wieloużytkownikowa — traktuj token jak hasło lokalne.

Budowanie strony lokalnie (symulacja GitHub Pages pod podścieżką `/ShellCraft/`):

```bash
npm run build:pages
npx vite preview --outDir dist-pages --base /ShellCraft/
```

## Znane ograniczenia / dalszy rozwój

- Bloki nie dzielą obecnie stanu sesji PowerShell (każdy odpala osobny proces) — zmienne ustawione w jednym bloku nie są widoczne w kolejnym. Następny krok: jedna trwała sesja PowerShell (np. przez `System.Management.Automation` runspace albo długo żyjący proces z markerami końca komendy) współdzielona między węzłami.
- Brak zapisu/wczytywania grafu (na razie stan istnieje tylko w pamięci okna).
- Brak typów węzłów poza "surowy skrypt PowerShell" (np. węzły warunkowe, pętle, zmienne wejścia/wyjścia między blokami).
