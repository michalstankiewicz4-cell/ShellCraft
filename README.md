# ShellCraft
Node‑Based PowerShell Console Integration, ShellCraft serves as the core engine for future UI layers, enabling advanced OSINT tooling, automation, and interactive scripting.

Concept pictures
<img width="1919" height="1199" alt="image" src="https://github.com/user-attachments/assets/69c114fd-93df-4c21-814f-02980f42e710" />

<img width="1919" height="1199" alt="image" src="https://github.com/user-attachments/assets/146da397-51b0-4ac8-b632-83af70822d6b" />

## Szybki start

Są dwa sposoby uruchomienia edytora. Wybierz jeden — nie trzeba obu.

### Opcja A: aplikacja desktopowa (najprostsze, polecane)

1. Pobierz z [Releases](https://github.com/michalstankiewicz4-cell/ShellCraft/releases/latest):
   - `shellcraft-setup.exe` lub `shellcraft.msi` — klasyczny instalator (dodaje skrót w Menu Start, sam doinstaluje [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/), jeśli go brakuje).
   - `shellcraft.exe` — samodzielny, przenośny plik, wystarczy odpalić dwuklikiem (nie trzeba instalować; wymaga WebView2 — na aktualnym Windows 10/11 jest to zwykle preinstalowane).
2. Uruchom. Windows SmartScreen może pokazać ostrzeżenie (plik jest niepodpisany certyfikatem) — kliknij "Więcej informacji" → "Uruchom mimo to".
3. Kliknij "Uruchom blok" na bloku `Get-Date` — gotowe, wynik pojawi się w bloku.

### Opcja B: przez przeglądarkę (https://michalstankiewicz4-cell.github.io/ShellCraft/)

Przeglądarka **nie może** sama uruchamiać PowerShell na Twoim komputerze — to celowe ograniczenie bezpieczeństwa każdej przeglądarki, nie coś do obejścia. Dlatego strona łączy się z małym programem (**agentem**), który musisz mieć uruchomiony **lokalnie, na tym samym komputerze**, na którym otwierasz stronę.

1. Pobierz `agent.exe` z [Releases](https://github.com/michalstankiewicz4-cell/ShellCraft/releases/latest) (albo zbuduj sam — patrz [Budowanie ze źródeł](#budowanie-ze-źródeł)).
2. Uruchom `agent.exe`. Zostaw okno konsoli otwarte — agent musi działać przez cały czas pracy na stronie.
3. Agent wypisze w konsoli **token** — losowy ciąg 64 znaków, unikalny dla Twojego komputera. Zapisuje się trwale w `%APPDATA%\ShellCraft\agent_token.txt`, więc przy kolejnych uruchomieniach agenta token jest ten sam.
4. Wejdź na https://michalstankiewicz4-cell.github.io/ShellCraft/.
5. Wklej token do pola "Token agenta" w pasku narzędzi, kliknij "Sprawdź połączenie" — kropka powinna zrobić się zielona.
6. Kliknij "Uruchom blok" na bloku `Get-Date`.

**Ważne:** token nie jest czymś, co da się "dostać" od kogoś innego ani ode mnie — generuje go lokalnie *Twój* agent, na *Twoim* komputerze, przy pierwszym uruchomieniu. Każda osoba, która chce korzystać ze strony, musi mieć **własnego, działającego agenta na swoim komputerze** i wkleić **swój** token. Strona jest publiczna, ale bez lokalnie uruchomionego agenta nic się nie wykona — połączenie po prostu nie dojdzie do skutku (czerwona kropka).

## Stack

- **Tauri 2 (Rust)** — backend, uruchamia bloki jako procesy `powershell.exe`
- **Vite + TypeScript (vanilla)** — frontend, edytor blokowo-węzłowy (canvas, drag & drop, połączenia SVG)

## Jak to działa

- Wszystkie bloki dzielą **jedną, długo żyjącą sesję PowerShell** (`SessionManager`/`ShellSession` w [src-tauri/src/lib.rs](src-tauri/src/lib.rs), używana zarówno przez aplikację desktopową, jak i przez agenta w trybie web) — zmienne, zaimportowane moduły, `cd` przechodzą z bloku do bloku, dokładnie jak w prawdziwej konsoli. Sesja startuje przy pierwszym uruchomionym bloku i żyje, dopóki nie zamkniesz aplikacji/agenta albo nie klikniesz "Nowa sesja".
- Pojedynczy blok ma limit **120 sekund** — jeśli go przekroczy (np. nieskończona pętla), zwróci błąd timeoutu. W takim wypadku sesja może zostać zawieszona (blokuje kolejne bloki) — użyj przycisku "🔄 Nowa sesja", żeby wymusić restart procesu PowerShell (traci wszystkie zmienne, ale odblokowuje dalszą pracę). Twardego przerwania pojedynczego zawieszonego bloku w locie na razie nie ma.
- Bloki łączy się przeciągając z kropki wyjścia (prawa, zielona) do kropki wejścia (lewa, niebieska) innego bloku — połączenia definiują kolejność wykonania w trybie "Uruchom graf" (sortowanie topologiczne, wykrywanie cykli).
- Kliknięcie na linię połączenia usuwa je.
- "💾 Zapisz" pobiera cały graf (bloki, pozycje, treść skryptów, połączenia — bez wyników) jako plik `.json`. "📂 Wczytaj" wczytuje taki plik z powrotem, zastępując bieżący graf.

## Model bezpieczeństwa trybu web

- Agent nasłuchuje wyłącznie na `127.0.0.1:47932` (niedostępny z sieci lokalnej ani internetu).
- Każde żądanie do `/run` wymaga poprawnego tokenu w nagłówku `X-ShellCraft-Token` — bez niego dowolna otwarta karta przeglądarki mogłaby po cichu próbować wysyłać komendy do agenta.
- CORS ograniczony do konkretnych originów (strona GitHub Pages oraz `localhost:1420` na potrzeby `npm run dev`) — inne strony nie dostaną odpowiedzi nawet ze złym tokenem.
- Odpowiedź zawiera nagłówek `Access-Control-Allow-Private-Network`, wymagany przez Chrome/Edge przy żądaniach z publicznej strony HTTPS do adresu prywatnego (`127.0.0.1`).
- Usunięcie pliku `%APPDATA%\ShellCraft\agent_token.txt` i restart agenta **unieważnia** stary token (generuje nowy) — to sposób na odcięcie dostępu, np. gdy podejrzewasz wyciek.
- To narzędzie deweloperskie dla jednego użytkownika na jego własnej maszynie, nie usługa wieloużytkownikowa — traktuj token jak hasło lokalne.

## Budowanie ze źródeł

```bash
npm install

# aplikacja desktopowa (dev, z hot-reloadem)
npm run tauri dev

# aplikacja desktopowa (release: .exe + instalator .msi/.exe w src-tauri/target/release)
npm run tauri build

# agent do trybu web (release: src-tauri/target/release/agent.exe)
cd src-tauri && cargo build --release --bin agent

# strona web lokalnie, symulacja GitHub Pages pod /ShellCraft/
npm run build:pages
npx vite preview --outDir dist-pages --base /ShellCraft/
```

Strona na GitHub Pages wdraża się automatycznie (`.github/workflows/deploy-pages.yml`) po każdym pushu do `main`.

## Wydawanie nowej wersji

Wypchnięcie tagu `vX.Y.Z` automatycznie buduje wszystkie cztery artefakty (`shellcraft.exe`, `shellcraft-setup.exe`, `shellcraft.msi`, `agent.exe`) i publikuje je jako GitHub Release (`.github/workflows/release.yml`):

```bash
git tag -a v0.2.0 -m "ShellCraft v0.2.0"
git push origin v0.2.0
```

Pliki nie są podpisane certyfikatem code-signing (Windows SmartScreen pokaże ostrzeżenie przy pierwszym uruchomieniu) — to świadomy kompromis, certyfikat kosztuje i wymaga weryfikacji tożsamości.

## Znane ograniczenia / dalszy rozwój

- Brak twardego przerwania pojedynczego zawieszonego bloku (np. nieskończonej pętli) — trzeba zrestartować całą sesję przyciskiem "Nowa sesja".
- Brak typów węzłów poza "surowy skrypt PowerShell" (np. węzły warunkowe, pętle, zmienne wejścia/wyjścia między blokami).
