/* ===== MD EDITOR — APP.JS ===== */

(() => {
    'use strict';

    // ── State ──────────────────────────────────────────
    let dirHandle = null;
    let currentFileHandle = null;
    let currentFileName = '';
    let isDirty = false;
    let autoSaveTimer = null;
    const AUTOSAVE_DELAY = 2000;
    const PREVIEW_DELAY = 150;
    // Pastas ocultas (.git, .obsidian...) e node_modules não entram no índice.
    const SKIP_DIR_RE = /^(\.|node_modules$)/;
    const INVALID_NAME_RE = /[\\:*?"<>|]/;

    // ── Wikilink / Backlink State ──────────────────────
    let fileHandleMap = {};        // { "path/note.md": FileSystemFileHandle }
    let backlinkIndex = {};        // { "note title (minúsculo)": ["path/a.md", "path/b.md"] }
    let noteCache = {};            // { "path/note.md": { modified, size, text, masked } }

    // ── Image State ────────────────────────────────────
    let imageHandleMap = {};       // { "path/img.png": FileSystemFileHandle }
    let imageObjectUrlCache = {};  // { "path/img.png": objectURL }
    const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
    const ASSETS_DIR = 'assets';

    // ── Folder State ───────────────────────────────────
    let selectedFolderPath = '';   // destino de "novo arquivo" / "nova pasta"

    // ── Backlog Map (backlog.js) ───────────────────────
    let backlog = null;

    // ── Mode ───────────────────────────────────────────
    // 'editor': edição de texto. 'map': mapa de backlog (product manager).
    // A moldura (lateral, título, árvore, atalhos) consulta este estado.
    let mode = 'editor';
    let mapSelection = '';         // nota selecionada no mapa ('' = visão geral)
    let tabBeforeMap = null;
    let collapsedFolders = new Set(loadJson('collapsedFolders', []));

    // ── DOM Elements ───────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const welcomeScreen = $('#welcome-screen');
    const splitPane = $('#split-pane');
    const editor = $('#editor');
    const editorPane = $('#editor-pane');
    const preview = $('#preview');
    const fileList = $('#file-list');
    const fileName = $('#file-name');
    const saveStatus = $('#save-status');
    const statusText = saveStatus.querySelector('.status-text');
    const sidePanel = $('#side-panel');

    // Buttons
    const btnOpenFolder = $('#btn-open-folder');
    const btnWelcomeOpen = $('#btn-welcome-open');
    const btnWelcomeReopen = $('#btn-welcome-reopen');
    const btnNewFile = $('#btn-new-file');
    const btnNewFolder = $('#btn-new-folder');
    const btnDailyNote = $('#btn-daily-note');

    // Modals
    const modalOverlay = $('#modal-overlay');
    const modalTitle = $('#new-file-title');
    const modalLocation = $('#new-file-location');
    const newFileInput = $('#new-file-input');
    const modalCancel = $('#modal-cancel');
    const modalCreate = $('#modal-create');
    const deleteOverlay = $('#delete-modal-overlay');
    const deleteText = $('#delete-confirm-text');
    const deleteCancel = $('#delete-cancel');
    const deleteConfirm = $('#delete-confirm');
    const switcherOverlay = $('#switcher-overlay');
    const switcherInput = $('#switcher-input');
    const switcherList = $('#switcher-list');
    const autocompleteList = $('#autocomplete');

    // Buttons — Export / Preview / PDF
    const btnExportHtml = $('#btn-export-html');
    const btnPreviewHtml = $('#btn-preview-html');
    const btnPrintPdf = $('#btn-print-pdf');

    // ── Local Storage Helpers ──────────────────────────

    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem('mdeditor:' + key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        try { localStorage.setItem('mdeditor:' + key, JSON.stringify(value)); } catch (_) { /* sem storage */ }
    }

    // ── IndexedDB (handle da última pasta) ─────────────

    function idbRequest(mode, fn) {
        return new Promise((resolve, reject) => {
            const open = indexedDB.open('md-editor', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('handles');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('handles', mode);
                const req = fn(tx.objectStore('handles'));
                tx.oncomplete = () => { db.close(); resolve(req.result); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            };
        });
    }

    const idbGet = (key) => idbRequest('readonly', (store) => store.get(key));
    const idbSet = (key, value) => idbRequest('readwrite', (store) => store.put(value, key));

    // ── Mermaid Setup ──────────────────────────────────
    // Config escura para o preview do app (fundo escuro).
    // securityLevel 'strict' remove scripts e cliques dos diagramas, mas mantém
    // <b>, <i> e <br> nos rótulos.
    const MERMAID_DARK_CONFIG = {
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        htmlLabels: true,
        flowchart: { htmlLabels: true },
        themeVariables: {
            darkMode: true,
            background: '#161b22',
            primaryColor: '#1f6feb',
            primaryTextColor: '#e6edf3',
            lineColor: '#58a6ff',
            secondaryColor: '#21262d',
            tertiaryColor: '#30363d'
        }
    };
    // Config clara para o HTML exportado (fundo branco).
    const MERMAID_LIGHT_CONFIG = {
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        htmlLabels: true,
        flowchart: { htmlLabels: true }
    };

    // ── Marked Setup ───────────────────────────────────
    marked.use({
        breaks: true,
        gfm: true,
        renderer: {
            code(text, lang) {
                const code = text || '';
                const language = (lang || '').split(/\s/)[0];
                if (language === 'mermaid') {
                    // Escapado: o texto volta intacto via textContent na hora de renderizar.
                    return `<div class="mermaid-block">${escapeHtml(code)}</div>`;
                }
                if (language && hljs.getLanguage(language)) {
                    const highlighted = hljs.highlight(code, { language }).value;
                    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
                }
                const highlighted = hljs.highlightAuto(code).value;
                return `<pre><code class="hljs">${highlighted}</code></pre>`;
            }
        }
    });

    // ── Text Helpers ───────────────────────────────────

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Minúsculas e sem acentos, para buscas tolerantes.
    function foldText(str) {
        return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    function slugify(text) {
        return foldText(text.trim())
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-');
    }

    function dirOf(path) {
        return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    }

    function joinPath(...parts) {
        return parts.filter(Boolean).join('/');
    }

    function noteTitle(path) {
        return path.split('/').pop().replace(/\.md$/i, '');
    }

    // Marca as linhas que estão dentro de blocos de código cercados (``` ou ~~~).
    function fenceMask(lines) {
        const mask = new Array(lines.length).fill(false);
        let fence = null;
        for (let i = 0; i < lines.length; i++) {
            const open = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
            if (fence) {
                mask[i] = true;
                const close = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
                if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
            } else if (open) {
                fence = open[1];
                mask[i] = true;
            }
        }
        return mask;
    }

    function isInFence(text, pos) {
        const mask = fenceMask(text.slice(0, pos).split('\n'));
        return mask[mask.length - 1];
    }

    // Busca por subsequência: todas as letras aparecem em ordem. Pontua letras
    // contíguas e início de palavra. Retorna 0 quando não casa.
    function fuzzyScore(query, text) {
        if (!query) return 1;
        const q = foldText(query);
        const t = foldText(text);
        let score = 0;
        let from = 0;
        let streak = 0;
        for (const ch of q) {
            const found = t.indexOf(ch, from);
            if (found === -1) return 0;
            streak = found === from ? streak + 1 : 0;
            score += 1 + streak * 2 + (found === 0 || /[\s\-_/]/.test(t[found - 1]) ? 3 : 0);
            from = found + 1;
        }
        if (t.startsWith(q)) score += 10;
        return Math.max(score - t.length * 0.01, 0.001);
    }

    // ── Wikilink Helpers ───────────────────────────────

    // "pasta/Nota#Seção" → { note: "pasta/Nota", heading: "Seção" }
    function parseLinkTarget(target) {
        const i = target.indexOf('#');
        if (i === -1) return { note: target.trim(), heading: '' };
        return { note: target.slice(0, i).trim(), heading: target.slice(i + 1).trim() };
    }

    // Resolve "Nota" ou "pasta/Nota" para o caminho indexado. Sem nota
    // ([[#Seção]]) aponta para o arquivo atual.
    function resolveNotePath(note) {
        if (!note) return currentFileName || null;
        const clean = note.replace(/\.md$/i, '');
        if (fileHandleMap[clean + '.md']) return clean + '.md';
        const title = noteTitle(clean).toLowerCase();
        const suffix = '/' + clean.toLowerCase() + '.md';
        let fallback = null;
        for (const path of Object.keys(fileHandleMap)) {
            if (noteTitle(path).toLowerCase() !== title) continue;
            if (('/' + path.toLowerCase()).endsWith(suffix)) return path;
            fallback = fallback || path;
        }
        return fallback;
    }

    function extractWikilinks(content) {
        const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const links = new Set();
        let m;
        while ((m = re.exec(content)) !== null) {
            const { note } = parseLinkTarget(m[1]);
            if (note && !IMAGE_EXT_RE.test(note)) links.add(noteTitle(note).toLowerCase());
        }
        return links;
    }

    // ── Wikilink Marked Extension ─────────────────────
    marked.use({
        extensions: [{
            name: 'wikilink',
            level: 'inline',
            start(src) { return src.indexOf('[['); },
            tokenizer(src) {
                const match = src.match(/^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
                if (match) {
                    return {
                        type: 'wikilink',
                        raw: match[0],
                        target: match[1].trim(),
                        alias: match[2] ? match[2].trim() : ''
                    };
                }
            },
            renderer(token) {
                const { note, heading } = parseLinkTarget(token.target);
                const exists = !!resolveNotePath(note);
                const cls = exists ? 'wikilink' : 'wikilink wikilink-missing';
                const display = token.alias || (note && heading ? `${note} › ${heading}` : note || heading);
                return `<a class="${cls}" data-wikilink="${escapeHtml(token.target)}" href="#">${escapeHtml(display)}</a>`;
            }
        }]
    });

    // ── Embed Marked Extension (Obsidian ![[img.png]] / ![[Nota]]) ───
    marked.use({
        extensions: [{
            name: 'embed',
            level: 'inline',
            start(src) { return src.indexOf('![['); },
            tokenizer(src) {
                const match = src.match(/^!\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
                if (!match) return;
                const target = match[1].trim();
                return {
                    type: 'embed',
                    raw: match[0],
                    kind: IMAGE_EXT_RE.test(target) ? 'image' : 'note',
                    target: target,
                    size: match[2] ? match[2].trim() : ''
                };
            },
            renderer(token) {
                if (token.kind === 'note') {
                    // Preenchido depois por resolveEmbeds().
                    return `<span class="note-embed" data-embed="${escapeHtml(token.target)}"></span>`;
                }
                const src = escapeHtml(token.target);
                const alt = escapeHtml(token.target.split('/').pop());
                let dim = '';
                const m = token.size.match(/^(\d+)(?:x(\d+))?$/);
                if (m) {
                    dim = ` width="${m[1]}"`;
                    if (m[2]) dim += ` height="${m[2]}"`;
                }
                return `<img alt="${alt}" src="${src}"${dim}>`;
            }
        }]
    });

    // ── Frontmatter ────────────────────────────────────

    const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

    function splitFrontmatter(text) {
        const m = text.match(FRONTMATTER_RE);
        if (!m) return { meta: null, body: text, lineOffset: 0 };
        return {
            meta: parseFrontmatter(m[1]),
            body: text.slice(m[0].length),
            lineOffset: (m[0].match(/\n/g) || []).length
        };
    }

    function unquote(str) {
        return str.replace(/^(['"])(.*)\1$/, '$2');
    }

    // YAML mínimo: "chave: valor", "chave: [a, b]" e listas "- item".
    function parseFrontmatter(src) {
        const entries = [];
        let last = null;
        for (const line of src.split(/\r?\n/)) {
            const item = last && line.match(/^\s*-\s+(.*)$/);
            if (item) {
                if (!Array.isArray(last.value)) last.value = last.value ? [last.value] : [];
                last.value.push(unquote(item[1].trim()));
                continue;
            }
            const kv = line.match(/^([^\s:#-][^:]*):\s*(.*)$/);
            if (!kv) continue;
            let value = kv[2].trim();
            // "[a, b]" é lista; "[[Nota]]" é wikilink.
            if (/^\[.*\]$/.test(value) && !value.startsWith('[[')) {
                value = value.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
            } else {
                value = unquote(value);
            }
            last = { key: kv[1].trim(), value };
            entries.push(last);
        }
        return entries;
    }

    function renderFrontmatter(entries) {
        if (!entries.length) return '';
        const rows = entries.map(({ key, value }) => {
            const values = Array.isArray(value) ? value : [value];
            const cell = /^(tags?|aliases)$/i.test(key)
                ? values.map(v => `<span class="fm-tag">${escapeHtml(v)}</span>`).join(' ')
                : escapeHtml(values.join(', '));
            return `<tr><th>${escapeHtml(key)}</th><td>${cell}</td></tr>`;
        }).join('');
        return `<table class="frontmatter" data-line="0"><tbody>${rows}</tbody></table>`;
    }

    // ── Markdown → HTML ────────────────────────────────

    // Converte markdown em HTML sanitizado. Cada bloco de nível superior recebe
    // data-line (linha de origem), usado pela rolagem sincronizada e pelo sumário.
    function markdownToHtml(text) {
        const { meta, body, lineOffset } = splitFrontmatter(text || '');
        const src = body.replace(/\r\n?/g, '\n');
        const tokens = marked.lexer(src);
        let html = meta ? renderFrontmatter(meta) : '';
        let line = lineOffset;
        let cursor = 0;
        for (const token of tokens) {
            const at = src.indexOf(token.raw, cursor);
            if (at !== -1) {
                line += (src.slice(cursor, at).match(/\n/g) || []).length;
                cursor = at;
            }
            const chunk = marked.parser(Object.assign([token], { links: tokens.links }));
            html += chunk.replace(/^<([a-z][a-z0-9]*)/i, `<$1 data-line="${line}"`);
            if (at !== -1) {
                line += (token.raw.match(/\n/g) || []).length;
                cursor = at + token.raw.length;
            }
        }
        if (typeof DOMPurify === 'undefined') {
            // Sem o sanitizador, mostra o texto cru em vez de arriscar HTML ativo.
            return `<pre>${escapeHtml(text || '')}</pre>`;
        }
        return DOMPurify.sanitize(html);
    }

    // Pipeline completo: markdown → HTML → notas incorporadas → callouts →
    // âncoras de títulos → checkboxes → imagens locais → Mermaid.
    // opts: { interactive, dark, useDataUrl, idPrefix, basePath, section, depth, seen, isStale }
    async function renderInto(container, text, opts) {
        const isStale = opts.isStale || (() => false);
        container.innerHTML = markdownToHtml(text);
        if (opts.section) extractSection(container, opts.section);
        await resolveEmbeds(container, opts);
        if (isStale()) return;
        applyCallouts(container);
        if (!opts.depth) assignHeadingIds(container, opts.idPrefix || '');
        enableTaskCheckboxes(container, opts);
        await resolveImages(container, opts.useDataUrl, opts.basePath || currentFileName);
        if (isStale()) return;
        await renderMermaidBlocks(container, opts.dark ? MERMAID_DARK_CONFIG : MERMAID_LIGHT_CONFIG, isStale);
    }

    // ── Callouts (Obsidian > [!note]) ──────────────────

    const CALLOUT_KINDS = {
        note: 'note', info: 'info', todo: 'info',
        tip: 'tip', hint: 'tip', important: 'tip',
        success: 'success', check: 'success', done: 'success',
        question: 'question', help: 'question', faq: 'question',
        warning: 'warning', caution: 'warning', attention: 'warning',
        failure: 'danger', fail: 'danger', missing: 'danger', danger: 'danger', error: 'danger', bug: 'danger',
        example: 'example', quote: 'quote', cite: 'quote',
        abstract: 'abstract', summary: 'abstract', tldr: 'abstract'
    };
    const CALLOUT_ICONS = {
        note: '✎', info: 'ℹ', tip: '✦', success: '✓', question: '?', warning: '⚠',
        danger: '✕', example: '☰', quote: '❝', abstract: '≡'
    };

    function applyCallouts(container) {
        for (const quote of container.querySelectorAll('blockquote')) {
            const first = quote.firstElementChild;
            if (!first || first.tagName !== 'P') continue;
            const m = first.innerHTML.match(/^\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)(?:<br>\n?|\n|$)/);
            if (!m) continue;

            const type = m[1].toLowerCase();
            const kind = CALLOUT_KINDS[type] || 'note';
            const foldable = !!m[2];
            first.innerHTML = first.innerHTML.slice(m[0].length);
            if (!first.innerHTML.trim()) first.remove();

            const box = document.createElement(foldable ? 'details' : 'div');
            box.className = `callout callout-${kind}`;
            if (m[2] === '+') box.open = true;
            if (quote.hasAttribute('data-line')) box.setAttribute('data-line', quote.getAttribute('data-line'));

            const head = document.createElement(foldable ? 'summary' : 'div');
            head.className = 'callout-title';
            // m[3] vem do HTML já sanitizado e não contém '<'.
            const title = m[3].trim() || escapeHtml(type.charAt(0).toUpperCase() + type.slice(1));
            head.innerHTML = `<span class="callout-icon">${CALLOUT_ICONS[kind]}</span><span>${title}</span>`;

            const body = document.createElement('div');
            body.className = 'callout-content';
            body.append(...quote.childNodes);
            box.append(head, body);
            quote.replaceWith(box);
        }
    }

    // ── Headings ───────────────────────────────────────

    const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

    function assignHeadingIds(container, prefix) {
        const used = {};
        for (const h of container.querySelectorAll(HEADING_SEL)) {
            if (h.closest('.note-embed')) continue;
            const base = slugify(h.textContent) || 'secao';
            used[base] = (used[base] || 0) + 1;
            h.id = prefix + (used[base] > 1 ? `${base}-${used[base] - 1}` : base);
        }
    }

    // Mantém só a seção cujo título casa com `heading` (até o próximo título
    // de nível igual ou maior).
    function extractSection(container, heading) {
        const want = slugify(heading);
        const start = [...container.children].find(el => /^H[1-6]$/.test(el.tagName) && slugify(el.textContent) === want);
        if (!start) {
            container.innerHTML = `<p class="note-embed-missing">Seção não encontrada: ${escapeHtml(heading)}</p>`;
            return;
        }
        const level = +start.tagName[1];
        const keep = [start];
        for (let el = start.nextElementSibling; el; el = el.nextElementSibling) {
            if (/^H[1-6]$/.test(el.tagName) && +el.tagName[1] <= level) break;
            keep.push(el);
        }
        container.replaceChildren(...keep);
    }

    // ── Note Embeds (![[Nota]]) ────────────────────────

    const MAX_EMBED_DEPTH = 2;

    async function resolveEmbeds(container, opts) {
        const depth = opts.depth || 0;
        const seen = opts.seen || new Set([currentFileName]);
        for (const el of container.querySelectorAll('.note-embed')) {
            const target = el.getAttribute('data-embed') || '';
            const { note, heading } = parseLinkTarget(target);
            const path = resolveNotePath(note);
            const label = note && heading ? `${noteTitle(note)} › ${heading}` : (note ? noteTitle(note) : heading);
            el.innerHTML = `<span class="note-embed-title"><a class="wikilink" data-wikilink="${escapeHtml(target)}" href="#">${escapeHtml(label)}</a></span>`;

            if (!path) {
                el.insertAdjacentHTML('beforeend', `<span class="note-embed-missing">Nota não encontrada: ${escapeHtml(target)}</span>`);
                continue;
            }
            if (depth >= MAX_EMBED_DEPTH || (seen.has(path) && !heading)) {
                el.insertAdjacentHTML('beforeend', '<span class="note-embed-missing">Incorporação interrompida (circular ou profunda demais)</span>');
                continue;
            }

            let text;
            try {
                text = path === currentFileName ? editor.value : await readNote(path);
            } catch (_) {
                el.insertAdjacentHTML('beforeend', '<span class="note-embed-missing">Não foi possível ler a nota</span>');
                continue;
            }
            const inner = document.createElement('div');
            inner.className = 'note-embed-content';
            await renderInto(inner, text, {
                ...opts,
                interactive: false,
                section: heading,
                depth: depth + 1,
                seen: new Set([...seen, path]),
                basePath: path
            });
            el.appendChild(inner);
        }
    }

    // ── Task Checkboxes ────────────────────────────────

    // Mesmo critério do marked: "[ ]" seguido de espaço.
    const TASK_LINE_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)[ xX](?=\] )/;

    function enableTaskCheckboxes(container, opts) {
        if (!opts.interactive) return;
        let i = 0;
        for (const box of container.querySelectorAll('input[type="checkbox"]')) {
            if (box.closest('.note-embed')) continue;
            box.removeAttribute('disabled');
            box.setAttribute('data-task', i++);
        }
    }

    // Posição (no texto) do caractere entre [ ] de cada tarefa, na ordem.
    function findTaskOffsets(text) {
        const { lineOffset } = splitFrontmatter(text);
        const lines = text.split('\n');
        const inFence = fenceMask(lines);
        const offsets = [];
        let pos = 0;
        for (let i = 0; i < lines.length; i++) {
            if (i >= lineOffset && !inFence[i]) {
                const m = lines[i].match(TASK_LINE_RE);
                if (m) offsets.push(pos + m[1].length);
            }
            pos += lines[i].length + 1;
        }
        return offsets;
    }

    // ── File System Access API ─────────────────────────

    async function openDirectory() {
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            idbSet('lastDir', handle).catch(() => { /* sem IndexedDB */ });
            await loadDirectory(handle);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Erro ao abrir pasta:', err);
                alert('Não foi possível abrir a pasta. Verifique se o navegador é compatível (Chrome/Edge).');
            }
        }
    }

    async function loadDirectory(handle) {
        if (isDirty && currentFileHandle) await saveCurrentFile();
        dirHandle = handle;
        closeCurrentFile();
        noteCache = {};
        selectedFolderPath = '';
        collapsedFolders = new Set(loadJson('collapsedFolders:' + handle.name, []));
        btnWelcomeReopen.classList.add('hidden');
        await refreshFileList();
        showEditor();
        const last = loadJson('lastFile:' + handle.name, '');
        if (last && fileHandleMap[last]) await openFileByPath(last, fileHandleMap[last]);
    }

    async function refreshFileList() {
        if (!dirHandle) return;
        // Reset image index/cache before re-scanning the folder.
        for (const url of Object.values(imageObjectUrlCache)) URL.revokeObjectURL(url);
        imageObjectUrlCache = {};
        imageHandleMap = {};
        const tree = await scanDirectory(dirHandle, '');
        renderFileTree(tree);
        await buildBacklinkIndex(tree);
        updateBacklinksPanel();
        updateMentionsPanel();
        if (backlog) backlog.onIndexChanged();
    }

    async function scanDirectory(handle, path) {
        const entries = { folders: [], files: [], otherFiles: 0 };

        for await (const [name, entryHandle] of handle) {
            if (entryHandle.kind === 'directory') {
                if (SKIP_DIR_RE.test(name)) continue;
                const subPath = path ? `${path}/${name}` : name;
                const children = await scanDirectory(entryHandle, subPath);
                entries.folders.push({
                    name: name,
                    path: subPath,
                    handle: entryHandle,
                    children: children
                });
            } else if (entryHandle.kind === 'file' && name.endsWith('.md')) {
                entries.files.push({
                    name: name,
                    path: path ? `${path}/${name}` : name,
                    handle: entryHandle
                });
            } else if (entryHandle.kind === 'file') {
                entries.otherFiles++;
                if (IMAGE_EXT_RE.test(name)) {
                    const imgPath = path ? `${path}/${name}` : name;
                    imageHandleMap[imgPath] = entryHandle;
                }
            }
        }

        entries.folders.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
        entries.files.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));

        return entries;
    }

    function countFiles(tree) {
        let count = tree.files.length;
        for (const folder of tree.folders) {
            count += countFiles(folder.children);
        }
        return count;
    }

    function countOtherFiles(tree) {
        let count = tree.otherFiles;
        for (const folder of tree.folders) {
            count += countOtherFiles(folder.children);
        }
        return count;
    }

    function renderFileTree(tree) {
        fileList.innerHTML = '';

        if (countFiles(tree) === 0 && tree.folders.length === 0) {
            fileList.innerHTML = '<li class="empty-state">Nenhum arquivo .md encontrado</li>';
            return;
        }

        renderTreeLevel(tree, fileList, 0);
    }

    function renderTreeLevel(tree, container, depth) {
        // Renderizar pastas primeiro. Pastas só com imagens/anexos ficam ocultas;
        // pastas vazias aparecem (acabaram de ser criadas).
        tree.folders.forEach(folder => {
            if (countFiles(folder.children) === 0 && countOtherFiles(folder.children) > 0) return;

            const collapsed = collapsedFolders.has(folder.path);
            const folderLi = document.createElement('li');
            folderLi.classList.add('folder-item');
            folderLi.dataset.path = folder.path;
            if (folder.path === selectedFolderPath) folderLi.classList.add('selected');
            folderLi.style.paddingLeft = `${16 + depth * 16}px`;

            const childContainer = document.createElement('ul');
            childContainer.classList.add('folder-children');
            if (!collapsed) childContainer.classList.add('expanded');

            folderLi.innerHTML = `
                <span class="folder-toggle${collapsed ? '' : ' expanded'}">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </span>
                <span class="file-icon">📁</span>
                <span class="folder-label">${escapeHtml(folder.name)}</span>
            `;

            folderLi.addEventListener('click', (e) => {
                if (e.target.closest('.file-item')) return;
                const toggle = folderLi.querySelector('.folder-toggle');
                const isExpanded = childContainer.classList.toggle('expanded');
                toggle.classList.toggle('expanded', isExpanded);
                if (isExpanded) collapsedFolders.delete(folder.path);
                else collapsedFolders.add(folder.path);
                saveJson('collapsedFolders:' + dirHandle.name, [...collapsedFolders]);
                selectFolder(folder.path);
            });

            container.appendChild(folderLi);
            renderTreeLevel(folder.children, childContainer, depth + 1);
            container.appendChild(childContainer);
        });

        // Renderizar arquivos
        tree.files.forEach(fileEntry => {
            const li = document.createElement('li');
            li.classList.add('file-item');
            li.dataset.path = fileEntry.path;
            li.style.paddingLeft = `${16 + depth * 16}px`;
            if (fileEntry.path === panelTarget()) li.classList.add('active');

            li.innerHTML = `
                <span class="file-icon">📄</span>
                <span class="file-label" title="${escapeHtml(fileEntry.path)}">${escapeHtml(fileEntry.name)}</span>
                <button class="file-delete" title="Deletar">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                    </svg>
                </button>
            `;

            li.addEventListener('click', (e) => {
                if (e.target.closest('.file-delete') || li.classList.contains('renaming')) return;
                navigateTo(fileEntry.path);
            });

            li.querySelector('.file-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                promptDeleteFile(fileEntry.path);
            });

            li.querySelector('.file-label').addEventListener('dblclick', (e) => {
                e.stopPropagation();
                startInlineRename(li, fileEntry);
            });

            container.appendChild(li);
        });
    }

    function selectFolder(path) {
        selectedFolderPath = path;
        fileList.querySelectorAll('.folder-item').forEach(li => {
            li.classList.toggle('selected', li.dataset.path === path);
        });
    }

    async function getDirHandle(path, create = false) {
        let handle = dirHandle;
        for (const part of path.split('/').filter(Boolean)) {
            handle = await handle.getDirectoryHandle(part, { create });
        }
        return handle;
    }

    // true se já existe arquivo OU pasta com esse nome em `dir`.
    async function entryExists(dir, name) {
        try {
            await dir.getFileHandle(name);
            return true;
        } catch (err) {
            if (err.name === 'TypeMismatchError') return true;
            if (err.name !== 'NotFoundError') throw err;
        }
        return false;
    }

    async function writeFile(handle, content) {
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
    }

    // Lê uma nota, reaproveitando o texto em cache se o arquivo não mudou.
    async function readNote(path, handle = fileHandleMap[path]) {
        const file = await handle.getFile();
        const hit = noteCache[path];
        if (hit && hit.modified === file.lastModified && hit.size === file.size) return hit.text;
        const text = await file.text();
        noteCache[path] = { modified: file.lastModified, size: file.size, text, masked: null };
        return text;
    }

    // Aberturas entram numa fila: renomear/deletar esperam a abertura em
    // andamento terminar antes de comparar com o arquivo atual.
    let openInFlight = Promise.resolve();

    function openFileByPath(path, handle) {
        const run = openInFlight.then(() => loadFile(path, handle));
        openInFlight = run.catch(() => { /* erro já tratado */ });
        return run;
    }

    async function loadFile(path, handle) {
        try {
            if (isDirty && currentFileHandle) {
                await saveCurrentFile();
            }
            clearTimeout(autoSaveTimer);

            const content = await readNote(path, handle);

            currentFileHandle = handle;
            currentFileName = path;
            isDirty = false;

            editor.value = content;
            closeAutocomplete();
            invalidateScrollMap();
            await updatePreview();
            editor.scrollTop = 0;
            preview.scrollTop = 0;
            updateFileName();
            setStatus('saved');
            if (mode === 'editor') splitPane.classList.remove('hidden');
            if (dirHandle) {
                if (mode === 'editor') selectFolder(dirOf(path));
                rememberRecent(path);
                saveJson('lastFile:' + dirHandle.name, path);
            }
            refreshContext();
        } catch (err) {
            console.error('Erro ao abrir arquivo:', err);
        }
    }

    function closeCurrentFile() {
        clearTimeout(autoSaveTimer);
        currentFileHandle = null;
        currentFileName = '';
        isDirty = false;
        editor.value = '';
        preview.innerHTML = '';
        updateFileName();
        setStatus('saved');
        splitPane.classList.add('hidden');
        refreshContext();
    }

    // Salvamentos passam por uma fila: dois createWritable simultâneos no
    // mesmo arquivo podem falhar.
    let saveChain = Promise.resolve();

    function saveCurrentFile() {
        saveChain = saveChain.then(() => writeCurrentFile(true));
        return saveChain;
    }

    async function writeCurrentFile(retryOnPermission) {
        clearTimeout(autoSaveTimer);
        if (!currentFileHandle) return;
        const handle = currentFileHandle;
        const path = currentFileName;
        const content = editor.value;
        try {
            setStatus('saving');
            await writeFile(handle, content);
            // Só marca como salvo se nada mudou durante a escrita.
            if (handle === currentFileHandle && editor.value === content) {
                isDirty = false;
                setStatus('saved');
            } else {
                setStatus('unsaved');
            }
            noteCache[path] = { modified: -1, size: -1, text: content, masked: null };
            indexLinks(path, content);
            updateBacklinksPanel();
            if (backlog) backlog.onIndexChanged();
        } catch (err) {
            console.error('Erro ao salvar:', err);
            setStatus('unsaved');
            // If permission was revoked, try to re-request
            if (err.name === 'NotAllowedError' && retryOnPermission) {
                try {
                    const permission = await handle.requestPermission({ mode: 'readwrite' });
                    if (permission === 'granted') await writeCurrentFile(false);
                } catch (_) { /* user denied */ }
            }
        }
    }

    // Cria `input` (pode conter subpastas: "projetos/ideia") dentro de `baseFolder`.
    // Nunca sobrescreve: se o arquivo existe, avisa e não faz nada.
    async function createFile(input, baseFolder = '', content = '', open = true) {
        if (!dirHandle) return null;
        let rel = input.trim().replace(/\\/g, '/');
        if (!rel) return null;
        if (!/\.md$/i.test(rel)) rel += '.md';
        const parts = joinPath(baseFolder, rel).split('/').map(s => s.trim()).filter(Boolean);
        const name = parts.pop();
        const dir = parts.join('/');
        const path = joinPath(dir, name);
        if (!name || name === '.md' || INVALID_NAME_RE.test(path) || parts.includes('..')) {
            alert('Nome inválido. Evite os caracteres \\ : * ? " < > |');
            return null;
        }
        try {
            const parent = await getDirHandle(dir, true);
            if (await entryExists(parent, name)) {
                alert(`"${path}" já existe.`);
                return null;
            }
            const handle = await parent.getFileHandle(name, { create: true });
            await writeFile(handle, content);
            await refreshFileList();
            if (open) await openFileByPath(path, fileHandleMap[path] || handle);
            return path;
        } catch (err) {
            console.error('Erro ao criar arquivo:', err);
            alert('Não foi possível criar o arquivo.');
            return null;
        }
    }

    async function createFolder(input) {
        if (!dirHandle) return;
        const rel = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!rel || INVALID_NAME_RE.test(rel) || rel.split('/').includes('..')) {
            alert('Nome de pasta inválido.');
            return;
        }
        const path = joinPath(selectedFolderPath, rel);
        try {
            const parent = await getDirHandle(dirOf(path), true);
            if (await entryExists(parent, path.split('/').pop())) {
                alert(`"${path}" já existe.`);
                return;
            }
            await getDirHandle(path, true);
            selectedFolderPath = path;
            collapsedFolders.delete(path);
            await refreshFileList();
        } catch (err) {
            console.error('Erro ao criar pasta:', err);
            alert('Não foi possível criar a pasta.');
        }
    }

    // ── Daily Note ─────────────────────────────────────

    async function openDailyNote() {
        if (!dirHandle) {
            openDirectory();
            return;
        }
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const name = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
        if (fileHandleMap[name]) {
            await openFileByPath(name, fileHandleMap[name]);
            return;
        }
        const heading = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        await createFile(name, '', `# ${heading.charAt(0).toUpperCase() + heading.slice(1)}\n\n`);
    }

    let pendingDeleteName = '';

    function promptDeleteFile(name) {
        pendingDeleteName = name;
        deleteText.textContent = `Tem certeza que deseja deletar "${name}"?`;
        deleteOverlay.classList.remove('hidden');
    }

    async function deleteFile(path) {
        if (!dirHandle) return;
        await openInFlight;
        try {
            const parentHandle = await getDirHandle(dirOf(path));
            await parentHandle.removeEntry(path.split('/').pop());

            delete noteCache[path];
            if (path === currentFileName) closeCurrentFile();
            await refreshFileList();
        } catch (err) {
            console.error('Erro ao deletar:', err);
            alert('Não foi possível deletar o arquivo.');
        }
    }

    // ── Backlink Index ─────────────────────────────────

    async function buildBacklinkIndex(tree) {
        fileHandleMap = {};
        backlinkIndex = {};

        const files = [];
        (function collect(subtree) {
            for (const f of subtree.files) {
                fileHandleMap[f.path] = f.handle;
                files.push(f);
            }
            for (const folder of subtree.folders) collect(folder.children);
        })(tree);

        for (const path of Object.keys(noteCache)) {
            if (!fileHandleMap[path]) delete noteCache[path];
        }

        // Lê em lotes paralelos; arquivos sem mudança vêm do cache.
        const BATCH = 24;
        for (let i = 0; i < files.length; i += BATCH) {
            await Promise.all(files.slice(i, i + BATCH).map(async (f) => {
                try {
                    indexLinks(f.path, await readNote(f.path, f.handle));
                } catch (_) { /* skip unreadable */ }
            }));
        }
    }

    function indexLinks(path, content) {
        for (const key of Object.keys(backlinkIndex)) {
            backlinkIndex[key] = backlinkIndex[key].filter(p => p !== path);
            if (backlinkIndex[key].length === 0) delete backlinkIndex[key];
        }
        for (const title of extractWikilinks(content)) {
            if (!backlinkIndex[title]) backlinkIndex[title] = [];
            backlinkIndex[title].push(path);
        }
    }

    function updateBacklinksPanel() {
        const target = panelTarget();
        if (!target) return;

        const title = noteTitle(target).toLowerCase();
        const linkedPaths = (backlinkIndex[title] || []).filter(p => p !== target);
        const linkedList = $('#backlinks-linked-list');
        $('#backlinks-linked-count').textContent = linkedPaths.length;
        linkedList.innerHTML = '';

        if (linkedPaths.length === 0) {
            linkedList.appendChild(emptyItem('Nenhuma nota aponta para cá'));
            return;
        }
        linkedPaths.forEach(path => {
            const li = document.createElement('li');
            li.className = 'backlink-item';
            li.innerHTML = `<span class="backlink-icon">📄</span><span class="backlink-name">${escapeHtml(noteTitle(path))}</span>`;
            li.title = path;
            li.addEventListener('click', () => navigateTo(path));
            linkedList.appendChild(li);
        });
    }

    function emptyItem(text) {
        const li = document.createElement('li');
        li.className = 'backlink-empty';
        li.textContent = text;
        return li;
    }

    // ── Unlinked Mentions ──────────────────────────────

    // Troca por espaços (mesmo tamanho) tudo que não conta como menção:
    // frontmatter, blocos e trechos de código, links, URLs e tags HTML.
    function maskForMentions(text) {
        const blank = (s) => s.replace(/[^\n]/g, ' ');
        const lines = text.split('\n');
        const inFence = fenceMask(lines);
        const { lineOffset } = splitFrontmatter(text);
        let out = lines.map((line, i) => (inFence[i] || i < lineOffset ? blank(line) : line)).join('\n');
        out = out
            .replace(/`[^`\n]*`/g, blank)
            .replace(/!?\[\[[^\]\n]*\]\]/g, blank)
            .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
            .replace(/https?:\/\/\S+/g, blank)
            .replace(/<[^>\n]+>/g, blank);
        return out;
    }

    function findMentions(path, text, title) {
        const entry = noteCache[path];
        let masked;
        if (entry && entry.text === text) {
            if (!entry.masked) entry.masked = maskForMentions(text);
            masked = entry.masked;
        } else {
            masked = maskForMentions(text);
        }
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(title)}(?![\\p{L}\\p{N}_])`, 'giu');
        const found = [];
        let m;
        while ((m = re.exec(masked)) !== null) {
            found.push({ index: m.index, text: text.substr(m.index, m[0].length) });
        }
        return found;
    }

    function updateMentionsPanel() {
        const list = $('#mentions-list');
        const countEl = $('#mentions-count');
        list.innerHTML = '';
        countEl.textContent = 0;
        const target = panelTarget();
        if (!target) return;

        const title = noteTitle(target);
        if (title.length < 3) {
            list.appendChild(emptyItem('Título curto demais para buscar menções'));
            return;
        }

        const results = [];
        for (const [path, entry] of Object.entries(noteCache)) {
            if (path === target || !fileHandleMap[path]) continue;
            const text = path === currentFileName ? editor.value : entry.text;
            const mentions = findMentions(path, text, title);
            if (mentions.length) results.push({ path, text, mentions });
        }
        countEl.textContent = results.length;

        if (!results.length) {
            list.appendChild(emptyItem('Nenhuma menção sem link'));
            return;
        }
        results.sort((a, b) => noteTitle(a.path).localeCompare(noteTitle(b.path), 'pt-BR'));
        for (const { path, text, mentions } of results) {
            const first = mentions[0];
            const from = Math.max(0, first.index - 40);
            const snippet = text.slice(from, first.index + first.text.length + 40).replace(/\s+/g, ' ');
            const li = document.createElement('li');
            li.className = 'mention-item';
            li.title = path;
            li.innerHTML = `
                <div class="mention-head">
                    <span class="backlink-name">${escapeHtml(noteTitle(path))}</span>
                    <span class="mention-count">${mentions.length}×</span>
                    <button class="mention-link" title="Transformar as menções desta nota em [[${escapeHtml(title)}]]">Vincular</button>
                </div>
                <div class="mention-snippet">${from > 0 ? '…' : ''}${escapeHtml(snippet)}…</div>
            `;
            li.addEventListener('click', (e) => {
                if (e.target.closest('.mention-link')) return;
                navigateTo(path);
            });
            li.querySelector('.mention-link').addEventListener('click', () => linkMentions(path, title));
            list.appendChild(li);
        }
    }

    async function linkMentions(path, title) {
        try {
            const handle = fileHandleMap[path];
            const text = path === currentFileName ? editor.value : await (await handle.getFile()).text();
            const mentions = findMentions(null, text, title);
            if (!mentions.length) return;
            let out = text;
            for (const m of mentions.slice().reverse()) {
                const link = m.text === title ? `[[${title}]]` : `[[${title}|${m.text}]]`;
                out = out.slice(0, m.index) + link + out.slice(m.index + m.text.length);
            }
            await writeNote(path, out);
            updateMentionsPanel();
        } catch (err) {
            console.error('Erro ao vincular menções:', err);
            alert('Não foi possível atualizar a nota.');
        }
    }

    // ── Outline (Sumário) ──────────────────────────────

    function topLevelHeadings() {
        return [...preview.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')];
    }

    function updateOutline() {
        const list = $('#outline-list');
        list.innerHTML = '';
        const headings = topLevelHeadings();
        if (!headings.length) {
            list.appendChild(emptyItem('Nenhum título nesta nota'));
            return;
        }
        const minLevel = Math.min(...headings.map(h => +h.tagName[1]));
        for (const h of headings) {
            const li = document.createElement('li');
            li.className = 'outline-item';
            li.dataset.target = h.id;
            li.style.paddingLeft = `${16 + (+h.tagName[1] - minLevel) * 12}px`;
            li.textContent = h.textContent;
            li.addEventListener('click', () => {
                scrollPreviewTo(h);
                scrollEditorToLine(+h.dataset.line);
            });
            list.appendChild(li);
        }
        updateActiveOutline();
    }

    function updateActiveOutline() {
        const top = preview.getBoundingClientRect().top + 40;
        let active = null;
        for (const h of topLevelHeadings()) {
            if (h.getBoundingClientRect().top <= top) active = h.id;
            else break;
        }
        $('#outline-list').querySelectorAll('.outline-item').forEach(li => {
            li.classList.toggle('active', li.dataset.target === active);
        });
    }

    // ── Side Panel Tabs ────────────────────────────────

    function showSideTab(name, persist = true) {
        sidePanel.querySelectorAll('.side-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === name);
        });
        sidePanel.querySelectorAll('.side-tab-panel').forEach(panel => {
            panel.classList.toggle('hidden', panel.dataset.panel !== name);
        });
        if (persist) saveJson('sideTab', name);
    }

    sidePanel.querySelectorAll('.side-tab').forEach(tab => {
        tab.addEventListener('click', () => showSideTab(tab.dataset.tab));
    });

    // ── Rename File ────────────────────────────────────

    function startInlineRename(li, fileEntry) {
        if (li.classList.contains('renaming')) return;
        li.classList.add('renaming');
        const labelSpan = li.querySelector('.file-label');
        const oldDisplayName = fileEntry.name.replace(/\.md$/i, '');

        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldDisplayName;
        input.className = 'rename-input';
        labelSpan.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = async () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim();
            li.classList.remove('renaming');
            if (newName && newName !== oldDisplayName) {
                await renameFile(fileEntry, newName + '.md');
            } else {
                await refreshFileList();
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') {
                committed = true;
                li.classList.remove('renaming');
                refreshFileList();
            }
        });
    }

    async function renameFile(fileEntry, newName) {
        if (!dirHandle) return;
        if (INVALID_NAME_RE.test(newName) || newName.includes('/')) {
            alert('Nome inválido. Evite os caracteres / \\ : * ? " < > |');
            await refreshFileList();
            return;
        }
        await openInFlight;
        const dir = dirOf(fileEntry.path);
        const oldFileName = fileEntry.path.split('/').pop();
        const newPath = joinPath(dir, newName);
        const isCurrent = fileEntry.path === currentFileName;
        // Só muda maiúsculas/minúsculas: em disco sem distinção, "b.md" e "B.md"
        // são o mesmo arquivo.
        const caseOnly = newName.toLowerCase() === oldFileName.toLowerCase();

        try {
            if (isCurrent && isDirty) await saveCurrentFile();
            const parentHandle = await getDirHandle(dir);
            if (!caseOnly && await entryExists(parentHandle, newName)) {
                alert(`"${newPath}" já existe. Escolha outro nome.`);
                await refreshFileList();
                return;
            }

            let newHandle = null;
            if (typeof fileEntry.handle.move === 'function') {
                try {
                    await fileEntry.handle.move(newName);
                    newHandle = fileEntry.handle;
                } catch (err) {
                    console.warn('move() indisponível nesta pasta; copiando o arquivo.', err);
                }
            }
            if (!newHandle) {
                const content = await (await fileEntry.handle.getFile()).text();
                if (caseOnly) {
                    // Passa por um nome temporário para não apagar o próprio arquivo.
                    const tmpName = `.renomeando-${Date.now()}.md`;
                    const tmp = await parentHandle.getFileHandle(tmpName, { create: true });
                    await writeFile(tmp, content);
                    await parentHandle.removeEntry(oldFileName);
                    newHandle = await parentHandle.getFileHandle(newName, { create: true });
                    await writeFile(newHandle, content);
                    await parentHandle.removeEntry(tmpName);
                } else {
                    newHandle = await parentHandle.getFileHandle(newName, { create: true });
                    await writeFile(newHandle, content);
                    await parentHandle.removeEntry(oldFileName);
                }
            }

            delete noteCache[fileEntry.path];
            if (isCurrent) {
                currentFileName = newPath;
                currentFileHandle = newHandle;
                updateFileName();
                saveJson('lastFile:' + dirHandle.name, newPath);
            }
            fileHandleMap[newPath] = newHandle;
            delete fileHandleMap[fileEntry.path];

            await updateWikilinkReferences(noteTitle(oldFileName), noteTitle(newName));
            await refreshFileList();
        } catch (err) {
            console.error('Erro ao renomear:', err);
            alert('Não foi possível renomear o arquivo.');
            await refreshFileList();
        }
    }

    async function updateWikilinkReferences(oldTitle, newTitle) {
        // [[Antigo]], [[pasta/Antigo#Seção|alias]], ![[Antigo]]
        const re = new RegExp(
            '(!?\\[\\[)((?:[^\\]|#\\n]*/)?)' + escapeRegex(oldTitle) + '((?:#[^\\]|\\n]*)?(?:\\|[^\\]\\n]*)?\\]\\])',
            'gi'
        );

        for (const [path, handle] of Object.entries(fileHandleMap)) {
            try {
                // A nota aberta é atualizada a partir do editor, não do disco.
                const content = path === currentFileName ? editor.value : await readNote(path, handle);
                const updated = content.replace(re, (m, open, folder, rest) => open + folder + newTitle + rest);
                if (updated === content) continue;
                await writeFile(handle, updated);
                noteCache[path] = { modified: -1, size: -1, text: updated, masked: null };
                if (path === currentFileName) syncEditorWithDisk(updated);
            } catch (_) { /* skip */ }
        }
    }

    // ── UI Helpers ─────────────────────────────────────

    function showEditor() {
        welcomeScreen.style.display = 'none';
        // Don't show split pane until a file is opened, but we show it if there's already a file
        if (currentFileName && mode === 'editor') {
            splitPane.classList.remove('hidden');
        }
    }

    // Nota que a moldura descreve: a aberta no editor ou a selecionada no mapa.
    function panelTarget() {
        return mode === 'map' ? mapSelection : currentFileName;
    }

    function setMode(next) {
        if (mode === next) return;
        mode = next;
        document.body.classList.toggle('map-mode', next === 'map');
        closeAutocomplete();
        if (next === 'map') {
            splitPane.classList.add('hidden');
            welcomeScreen.style.display = 'none';
            // O sumário descreve o preview do editor, que some no mapa.
            const active = sidePanel.querySelector('.side-tab.active');
            tabBeforeMap = active ? active.dataset.tab : null;
            if (tabBeforeMap === 'outline') showSideTab('backlinks', false);
        } else {
            if (currentFileName) splitPane.classList.remove('hidden');
            else if (!dirHandle) welcomeScreen.style.display = '';
            if (tabBeforeMap === 'outline') showSideTab('outline', false);
            tabBeforeMap = null;
        }
        refreshContext();
    }

    // Abre `path` no modo atual: no mapa, seleciona o item (ou mostra a nota
    // no painel do mapa); no editor, abre para edição.
    function navigateTo(path) {
        if (mode === 'map' && backlog) backlog.focusPath(path);
        else if (fileHandleMap[path]) openFileByPath(path, fileHandleMap[path]);
    }

    function openInEditor(path) {
        setMode('editor');
        if (fileHandleMap[path]) return openFileByPath(path, fileHandleMap[path]);
        return null;
    }

    // Atualiza título da aba, destaque na árvore e painel lateral.
    function refreshContext() {
        updateTitle();
        highlightActiveFile();
        const target = panelTarget();
        sidePanel.classList.toggle('hidden', !target);
        if (target) {
            updateBacklinksPanel();
            updateMentionsPanel();
        }
    }

    function updateTitle() {
        if (mode === 'map') {
            document.title = `Mapa — ${dirHandle ? dirHandle.name : 'backlog'} — MD Editor`;
        } else {
            document.title = currentFileName ? `${noteTitle(currentFileName)} — MD Editor` : 'MarkDown Editor';
        }
    }

    // ── Preview ────────────────────────────────────────

    let previewTimer = null;
    let renderGen = 0;

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(updatePreview, PREVIEW_DELAY);
    }

    // Renderiza fora da tela e troca de uma vez. Se outra renderização começar
    // no meio (digitação rápida), esta é descartada.
    async function updatePreview() {
        clearTimeout(previewTimer);
        const gen = ++renderGen;
        const isStale = () => gen !== renderGen;
        const next = document.createElement('div');
        await renderInto(next, editor.value, {
            interactive: true,
            dark: true,
            idPrefix: 'h-',
            basePath: currentFileName,
            isStale
        });
        if (isStale()) return;
        preview.replaceChildren(...next.childNodes);
        invalidateScrollMap();
        updateOutline();
    }

    function scrollPreviewTo(el) {
        const offset = el.getBoundingClientRect().top - preview.getBoundingClientRect().top;
        ignoreScroll.set(editor, performance.now() + 150);
        preview.scrollTop += offset - 8;
    }

    function scrollPreviewToHeading(text) {
        const el = preview.querySelector('#' + CSS.escape('h-' + slugify(text)));
        if (el) scrollPreviewTo(el);
    }

    function scrollEditorToLine(line) {
        if (!scrollState) scrollState = buildScrollMap();
        const top = scrollState.lineTops[line];
        if (top === undefined) return;
        ignoreScroll.set(preview, performance.now() + 150);
        editor.scrollTop = top - parseFloat(getComputedStyle(editor).paddingTop);
        const pos = editor.value.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0);
        editor.setSelectionRange(pos, pos);
    }

    // ── Local Image Resolution ─────────────────────────

    // Resolve a relative path (e.g. "../assets/a.png") against a base directory.
    function resolveRelativePath(baseDir, relative) {
        const stack = baseDir ? baseDir.split('/') : [];
        for (const part of relative.split('/')) {
            if (part === '' || part === '.') continue;
            if (part === '..') stack.pop();
            else stack.push(part);
        }
        return stack.join('/');
    }

    // Find an indexed image file for a markdown `src`. Resolves relative to the
    // note's folder first, then falls back to a vault-wide filename match
    // (Obsidian-style embeds reference images by name only).
    function findImage(src, basePath) {
        let path = src;
        try { path = decodeURIComponent(src); } catch (e) { /* keep raw */ }
        path = path.replace(/^<|>$/g, '').trim();

        const candidates = [
            resolveRelativePath(dirOf(basePath || ''), path),
            path.replace(/^\.?\//, '')
        ];
        for (const key of candidates) {
            if (imageHandleMap[key]) return { handle: imageHandleMap[key], key };
        }

        const base = path.split('/').pop();
        for (const key of Object.keys(imageHandleMap)) {
            if (key.split('/').pop() === base) return { handle: imageHandleMap[key], key };
        }
        return null;
    }

    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function getImageObjectUrl(found) {
        if (imageObjectUrlCache[found.key]) return imageObjectUrlCache[found.key];
        const file = await found.handle.getFile();
        const url = URL.createObjectURL(file);
        imageObjectUrlCache[found.key] = url;
        return url;
    }

    // Replace local <img> sources with usable URLs. Live preview uses object
    // URLs (cheap); export/standalone preview uses data URLs (self-contained).
    async function resolveImages(container, useDataUrl, basePath) {
        const imgs = container.querySelectorAll('img:not([data-img-missing])');
        for (const img of imgs) {
            const rawSrc = img.getAttribute('src') || '';
            if (!rawSrc || /^(https?:|data:|blob:)/i.test(rawSrc)) continue;
            const found = findImage(rawSrc, basePath);
            if (!found) {
                img.setAttribute('data-img-missing', '1');
                img.setAttribute('alt', (img.getAttribute('alt') || '') + ' (imagem não encontrada)');
                continue;
            }
            try {
                if (useDataUrl) {
                    const file = await found.handle.getFile();
                    img.src = await fileToDataUrl(file);
                } else {
                    img.src = await getImageObjectUrl(found);
                }
            } catch (e) {
                img.setAttribute('data-img-missing', '1');
            }
        }
    }

    // ── Paste / Drop Images ────────────────────────────

    const MIME_EXT = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif'
    };

    function timestamp() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    // Grava as imagens em assets/ e insere ![[nome]] no cursor. O nome é único
    // no cofre inteiro, porque ![[nome]] é resolvido só pelo nome do arquivo.
    async function saveImageFiles(files) {
        if (!dirHandle || !currentFileHandle) {
            alert('Abra uma pasta e uma nota para colar imagens.');
            return;
        }
        const taken = new Set(Object.keys(imageHandleMap).map(k => k.split('/').pop().toLowerCase()));
        const dir = await getDirHandle(ASSETS_DIR, true);
        const links = [];
        for (const file of files) {
            const extMatch = file.name.match(IMAGE_EXT_RE);
            const ext = MIME_EXT[file.type] || (extMatch && extMatch[1].toLowerCase());
            if (!ext) continue;
            // Imagens coladas chegam como "image.png": usa data e hora.
            const original = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|[\]#^]+/g, '-').trim();
            const stem = !original || /^image$/i.test(original) ? `imagem-${timestamp()}` : original;
            let name = `${stem}.${ext}`;
            for (let n = 1; taken.has(name.toLowerCase()) || await entryExists(dir, name); n++) {
                name = `${stem}-${n}.${ext}`;
            }
            taken.add(name.toLowerCase());
            const handle = await dir.getFileHandle(name, { create: true });
            await writeFile(handle, file);
            imageHandleMap[`${ASSETS_DIR}/${name}`] = handle;
            links.push(`![[${name}]]`);
        }
        if (links.length) editEditor(editor.selectionStart, editor.selectionEnd, links.join('\n'));
    }

    function imageFiles(list) {
        return [...(list || [])].filter(f => f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name));
    }

    editor.addEventListener('paste', (e) => {
        const files = imageFiles(e.clipboardData && e.clipboardData.files);
        if (!files.length) return;
        e.preventDefault();
        saveImageFiles(files).catch(err => {
            console.error('Erro ao salvar imagem:', err);
            alert('Não foi possível salvar a imagem.');
        });
    });

    editor.addEventListener('dragover', (e) => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });

    editor.addEventListener('drop', (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files.length) return;
        // Sem isso o navegador abre o arquivo solto e sai do app.
        e.preventDefault();
        const files = imageFiles(e.dataTransfer.files);
        if (!files.length) return;
        saveImageFiles(files).catch(err => {
            console.error('Erro ao salvar imagem:', err);
            alert('Não foi possível salvar a imagem.');
        });
    });

    // ── Mermaid ────────────────────────────────────────

    // Troca setas unicode (→ ⟶ ⇒ ➜ ➔) usadas como CONEXÃO por '-->'. Só
    // converte fora dos rótulos (colchetes/parênteses/chaves); dentro deles a
    // seta é texto legítimo e deve ser preservada.
    function normalizeMermaidArrows(def) {
        const ARROWS = '→⟶⇒➜➔';
        let out = '';
        let depth = 0;
        for (let i = 0; i < def.length; i++) {
            const ch = def[i];
            if (ch === '[' || ch === '(' || ch === '{') depth++;
            else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
            if (depth === 0 && ARROWS.indexOf(ch) !== -1) { out += '-->'; continue; }
            out += ch;
        }
        return out;
    }

    // Mermaid não interpreta markdown nem '\n' nos rótulos. Convertendo setas
    // de conexão, quebras de linha literais e **negrito**/*itálico* para o que
    // o Mermaid entende (htmlLabels ativo).
    function preprocessMermaid(def) {
        return normalizeMermaidArrows(def)
            .replace(/\\n/g, '<br/>')
            .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
            .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
    }

    // O Mermaid tem configuração global (tema). As renderizações passam por uma
    // fila para que o export (tema claro) não se misture com o preview (escuro).
    let mermaidQueue = Promise.resolve();
    let mermaidSeq = 0;
    const mermaidSvgCache = new Map();  // "tema\ndefinição" → svg

    function renderMermaidBlocks(container, config, isStale = () => false) {
        const run = async () => {
            if (typeof mermaid === 'undefined') return;
            const blocks = container.querySelectorAll('.mermaid-block:not(.rendered):not(.error)');
            if (!blocks.length) return;
            mermaid.initialize(config);
            for (const block of blocks) {
                if (isStale()) return;
                const definition = preprocessMermaid(block.textContent);
                const key = config.theme + '\n' + definition;
                const id = `mm-${++mermaidSeq}`;
                try {
                    let svg = mermaidSvgCache.get(key);
                    if (!svg) {
                        ({ svg } = await mermaid.render(id, definition));
                        mermaidSvgCache.set(key, svg);
                        if (mermaidSvgCache.size > 100) mermaidSvgCache.delete(mermaidSvgCache.keys().next().value);
                    }
                    block.innerHTML = svg;
                    block.classList.add('rendered');
                } catch (err) {
                    const el = document.getElementById('d' + id);
                    if (el) el.remove();
                    block.innerHTML = `<pre class="mermaid-error">⚠ Erro no diagrama Mermaid:\n${escapeHtml((err && err.message) || err)}</pre>`;
                    block.classList.add('error');
                }
            }
        };
        const done = mermaidQueue.then(run, run);
        mermaidQueue = done.catch(() => { /* erro já tratado */ });
        return done;
    }

    function updateFileName() {
        fileName.textContent = currentFileName || '';
        updateTitle();
    }

    function highlightActiveFile() {
        const target = panelTarget();
        fileList.querySelectorAll('.file-item').forEach(li => {
            li.classList.toggle('active', li.dataset.path === target);
        });
    }

    function setStatus(state) {
        saveStatus.className = 'save-status ' + state;
        const labels = { saved: 'Salvo ✓', saving: 'Salvando...', unsaved: 'Não salvo •' };
        statusText.textContent = labels[state] || 'Pronto';
    }

    // ── Auto-Save ──────────────────────────────────────

    function scheduleAutoSave() {
        if (!currentFileHandle) return;
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        isDirty = true;
        setStatus('unsaved');
        autoSaveTimer = setTimeout(() => {
            saveCurrentFile();
        }, AUTOSAVE_DELAY);
    }

    // Avisa antes de fechar a aba com alterações pendentes e tenta salvar ao
    // trocar de aba ou minimizar.
    window.addEventListener('beforeunload', (e) => {
        if (!isDirty) return;
        saveCurrentFile();
        e.preventDefault();
        e.returnValue = '';
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && isDirty) saveCurrentFile();
    });

    // ── Editing Helper ─────────────────────────────────

    // Substitui [start, end) no editor preservando o histórico do Ctrl+Z.
    // execCommand dispara 'input', que atualiza o preview e agenda o auto-save.
    function editEditor(start, end, text, keepScroll = false) {
        const scroll = keepScroll ? [editor.scrollTop, preview.scrollTop] : null;
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(start, end);
        const ok = text
            ? document.execCommand('insertText', false, text)
            : start === end || document.execCommand('delete');
        if (!ok) {
            editor.setRangeText(text, start, end, 'end');
            editor.dispatchEvent(new Event('input'));
        }
        if (scroll) {
            ignoreScroll.set(editor, performance.now() + 150);
            ignoreScroll.set(preview, performance.now() + 150);
            editor.scrollTop = scroll[0];
            preview.scrollTop = scroll[1];
        }
    }

    // ── Auto-Renumber Ordered Lists ──────────────────
    // O primeiro item de cada lista mantém seu número (uma lista pode começar
    // em 5); os seguintes seguem em sequência. Blocos de código são ignorados.
    function renumberOrderedLists(text) {
        const lines = text.split('\n');
        const inFence = fenceMask(lines);
        let counters = null;  // { indentação: próximo número }
        let changed = false;

        for (let i = 0; i < lines.length; i++) {
            if (inFence[i]) {
                counters = null;
                continue;
            }
            const match = lines[i].match(/^(\s*)(\d+)(\.)\s/);
            if (match) {
                const indent = match[1].length;
                const num = parseInt(match[2], 10);
                if (!counters) counters = {};
                // Subníveis mais fundos recomeçam a cada novo item deste nível.
                for (const key of Object.keys(counters)) {
                    if (+key > indent) delete counters[key];
                }
                if (counters[indent] === undefined) {
                    counters[indent] = num;
                } else if (num !== counters[indent]) {
                    lines[i] = match[1] + counters[indent] + lines[i].substring(match[1].length + match[2].length);
                    changed = true;
                }
                counters[indent]++;
            } else if (lines[i].trim() !== '') {
                const indent = lines[i].match(/^\s*/)[0].length;
                if (indent === 0) {
                    counters = null;
                } else if (counters) {
                    for (const key of Object.keys(counters)) {
                        if (+key > indent) delete counters[key];
                    }
                }
            }
        }

        return changed ? lines.join('\n') : null;
    }

    // Trecho que difere entre dois textos: prefixo e sufixo comuns.
    function diffRange(text, next) {
        let head = 0;
        while (head < text.length && text[head] === next[head]) head++;
        let tail = 0;
        while (tail < text.length - head && tail < next.length - head &&
            text[text.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
        return { head, tail };
    }

    // Troca o texto do editor por `next` mexendo só no trecho alterado, pelo
    // mesmo caminho da digitação: o Ctrl+Z continua funcionando. No modo mapa
    // o editor está escondido e não aceita foco; ele fica fora da tela, mas
    // renderizado, durante a troca.
    function replaceEditorText(next) {
        const text = editor.value;
        if (text === next) return;
        const { head, tail } = diffRange(text, next);
        const oldEnd = text.length - tail;
        const newEnd = next.length - tail;
        const shift = (p) => (p <= head ? p : (p >= oldEnd ? p + newEnd - oldEnd : newEnd));
        const sel = [shift(editor.selectionStart), shift(editor.selectionEnd)];
        const active = document.activeElement;
        const hidden = splitPane.classList.contains('hidden');
        if (hidden) splitPane.classList.replace('hidden', 'offscreen');
        try {
            editEditor(head, oldEnd, next.slice(head, newEnd), true);
        } finally {
            if (hidden) splitPane.classList.replace('offscreen', 'hidden');
        }
        editor.setSelectionRange(sel[0], sel[1]);
        if (active && active !== editor && active !== document.body) active.focus({ preventScroll: true });
    }

    // Depois de gravar `text` em disco para a nota aberta, alinha o editor.
    function syncEditorWithDisk(text) {
        replaceEditorText(text);
        clearTimeout(autoSaveTimer);
        if (editor.value === text) {
            isDirty = false;
            setStatus('saved');
        } else {
            scheduleAutoSave();
        }
    }

    let renumbering = false;

    function applyRenumber() {
        if (renumbering) return;
        const text = editor.value;
        const next = renumberOrderedLists(text);
        if (next === null) return;
        // Troca só o trecho que mudou, para o Ctrl+Z desfazer só a renumeração.
        const { head, tail } = diffRange(text, next);
        const caret = editor.selectionStart;
        const delta = next.length - text.length;
        renumbering = true;
        try {
            editEditor(head, text.length - tail, next.slice(head, next.length - tail));
        } finally {
            renumbering = false;
        }
        const pos = caret >= text.length - tail ? caret + delta : caret;
        editor.setSelectionRange(pos, pos);
    }

    // ── Toolbar Formatting ─────────────────────────────

    function insertFormatting(action) {
        if (!currentFileHandle) return;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const sel = editor.value.substring(start, end);
        let replacement = '';
        let cursorOffset = 0;

        switch (action) {
            case 'bold':
                replacement = `**${sel || 'texto'}**`;
                cursorOffset = sel ? replacement.length : 2;
                break;
            case 'italic':
                replacement = `_${sel || 'texto'}_`;
                cursorOffset = sel ? replacement.length : 1;
                break;
            case 'strikethrough':
                replacement = `~~${sel || 'texto'}~~`;
                cursorOffset = sel ? replacement.length : 2;
                break;
            case 'heading':
                replacement = `## ${sel || 'Título'}`;
                cursorOffset = replacement.length;
                break;
            case 'code':
                replacement = `\`${sel || 'código'}\``;
                cursorOffset = sel ? replacement.length : 1;
                break;
            case 'codeblock':
                replacement = `\n\`\`\`\n${sel || 'código aqui'}\n\`\`\`\n`;
                cursorOffset = sel ? replacement.length : 5;
                break;
            case 'link':
                replacement = `[${sel || 'texto'}](url)`;
                cursorOffset = sel ? replacement.length - 1 : 1;
                break;
            case 'image':
                replacement = `![${sel || 'alt'}](url)`;
                cursorOffset = sel ? replacement.length - 1 : 2;
                break;
            case 'ul':
                replacement = `- ${sel || 'item'}`;
                cursorOffset = replacement.length;
                break;
            case 'ol':
                replacement = `1. ${sel || 'item'}`;
                cursorOffset = replacement.length;
                break;
            case 'task':
                replacement = `- [ ] ${sel || 'tarefa'}`;
                cursorOffset = replacement.length;
                break;
            case 'quote':
                replacement = `> ${sel || 'citação'}`;
                cursorOffset = replacement.length;
                break;
            case 'callout':
                replacement = `> [!note] ${sel || 'Título'}\n> Conteúdo`;
                cursorOffset = replacement.length;
                break;
            case 'hr':
                replacement = `\n---\n`;
                cursorOffset = replacement.length;
                break;
            case 'table':
                replacement = `\n| Coluna 1 | Coluna 2 | Coluna 3 |\n|----------|----------|----------|\n| célula   | célula   | célula   |\n`;
                cursorOffset = replacement.length;
                break;
            case 'wikilink':
                replacement = `[[${sel || 'Nome da Nota'}]]`;
                cursorOffset = sel ? replacement.length : 2;
                break;
            default:
                return;
        }

        editEditor(start, end, replacement);
        const newPos = start + cursorOffset;
        editor.setSelectionRange(newPos, newPos);
    }

    // ── Resize Handle ──────────────────────────────────

    function initResizeHandle() {
        const handle = $('#resize-handle');
        let startX, startWidths;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            handle.classList.add('dragging');

            startX = e.clientX;
            const previewPane = $('#preview-pane');
            startWidths = {
                editor: editorPane.offsetWidth,
                preview: previewPane.offsetWidth
            };

            const onMouseMove = (e) => {
                const dx = e.clientX - startX;
                const totalWidth = startWidths.editor + startWidths.preview;
                const newEditorWidth = Math.max(200, Math.min(totalWidth - 200, startWidths.editor + dx));
                const newPreviewWidth = totalWidth - newEditorWidth;

                splitPane.style.gridTemplateColumns = `${newEditorWidth}px 4px ${newPreviewWidth}px`;
            };

            const onMouseUp = () => {
                handle.classList.remove('dragging');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // ── Editor Mirror (medidas de linhas e do cursor) ──
    // O <textarea> não expõe a posição de cada linha. Um div invisível com a
    // mesma fonte e largura reproduz a quebra de linhas para medir.

    const mirror = document.createElement('div');
    mirror.className = 'editor-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    editorPane.appendChild(mirror);

    function syncMirrorStyle() {
        const cs = getComputedStyle(editor);
        for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
            'wordSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
            mirror.style[prop] = cs[prop];
        }
        mirror.style.width = editor.clientWidth + 'px';
    }

    // Posição do cursor relativa ao canto superior esquerdo do editor visível.
    function caretCoords(pos) {
        syncMirrorStyle();
        mirror.textContent = editor.value.slice(0, pos);
        const marker = document.createElement('span');
        marker.textContent = '​';
        mirror.appendChild(marker);
        const coords = {
            top: marker.offsetTop - editor.scrollTop,
            left: marker.offsetLeft - editor.scrollLeft,
            height: marker.offsetHeight
        };
        mirror.replaceChildren();
        return coords;
    }

    // ── Scroll Sync ────────────────────────────────────
    // Pares (y no editor, y no preview) para cada bloco com data-line; a
    // posição entre dois pares é interpolada.

    let scrollState = null;            // { map: [[editorY, previewY]], lineTops }
    const ignoreScroll = new Map();    // elemento → instante até o qual ignorar
    let scrollRaf = 0;

    function invalidateScrollMap() {
        scrollState = null;
    }

    function buildScrollMap() {
        syncMirrorStyle();
        const lines = editor.value.split('\n');
        mirror.replaceChildren(...lines.map(line => {
            const div = document.createElement('div');
            div.textContent = line || '​';
            return div;
        }));
        const lineTops = [...mirror.children].map(div => div.offsetTop);
        mirror.replaceChildren();

        const base = preview.getBoundingClientRect().top - preview.scrollTop;
        const map = [[0, 0]];
        for (const el of preview.querySelectorAll(':scope > [data-line]')) {
            const ey = lineTops[+el.dataset.line];
            if (ey === undefined) continue;
            const py = el.getBoundingClientRect().top - base;
            const last = map[map.length - 1];
            if (ey > last[0] && py > last[1]) map.push([ey, py]);
        }
        const last = map[map.length - 1];
        map.push([Math.max(editor.scrollHeight, last[0] + 1), Math.max(preview.scrollHeight, last[1] + 1)]);
        return { map, lineTops };
    }

    function interpolate(map, value, from) {
        const to = 1 - from;
        for (let i = 1; i < map.length; i++) {
            if (value <= map[i][from]) {
                const a = map[i - 1];
                const b = map[i];
                const span = b[from] - a[from];
                const t = span ? (value - a[from]) / span : 0;
                return a[to] + t * (b[to] - a[to]);
            }
        }
        return map[map.length - 1][to];
    }

    function syncScroll(source) {
        if (splitPane.classList.contains('hidden') || !currentFileName) return;
        const target = source === editor ? preview : editor;
        if (!scrollState) scrollState = buildScrollMap();
        const atBottom = source.scrollTop >= source.scrollHeight - source.clientHeight - 2;
        const y = atBottom
            ? target.scrollHeight
            : interpolate(scrollState.map, source.scrollTop, source === editor ? 0 : 1);
        ignoreScroll.set(target, performance.now() + 100);
        target.scrollTop = y;
    }

    function onPaneScroll(source) {
        if (source === preview) updateActiveOutline();
        if (performance.now() < (ignoreScroll.get(source) || 0)) return;
        cancelAnimationFrame(scrollRaf);
        scrollRaf = requestAnimationFrame(() => syncScroll(source));
    }

    editor.addEventListener('scroll', () => {
        onPaneScroll(editor);
        if (ac.open) positionAutocomplete();
    });
    preview.addEventListener('scroll', () => onPaneScroll(preview));
    // Imagens carregam depois da troca do preview e mudam as alturas.
    preview.addEventListener('load', invalidateScrollMap, true);
    new ResizeObserver(invalidateScrollMap).observe(editor);
    new ResizeObserver(invalidateScrollMap).observe(preview);

    // ── Wikilink Autocomplete ([[ e ![[) ───────────────

    const ac = { open: false, items: [], index: 0, start: 0 };

    function autocompleteCandidates(query, isEmbed) {
        const titleCount = {};
        for (const path of Object.keys(fileHandleMap)) {
            const t = noteTitle(path).toLowerCase();
            titleCount[t] = (titleCount[t] || 0) + 1;
        }
        const items = Object.keys(fileHandleMap).map(path => {
            const title = noteTitle(path);
            // Títulos repetidos em pastas diferentes: insere o caminho.
            const insert = titleCount[title.toLowerCase()] > 1 ? path.replace(/\.md$/i, '') : title;
            return { label: title, detail: dirOf(path), insert, icon: '📄' };
        });
        if (isEmbed) {
            for (const key of Object.keys(imageHandleMap)) {
                const name = key.split('/').pop();
                items.push({ label: name, detail: dirOf(key), insert: name, icon: '🖼' });
            }
        }
        return items
            .map(item => ({ item, score: fuzzyScore(query, item.label) }))
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label, 'pt-BR'))
            .slice(0, 8)
            .map(r => r.item);
    }

    function updateAutocomplete() {
        const pos = editor.selectionStart;
        if (!dirHandle || pos !== editor.selectionEnd) return closeAutocomplete();
        const lineStart = editor.value.lastIndexOf('\n', pos - 1) + 1;
        const m = editor.value.slice(lineStart, pos).match(/(!?)\[\[([^[\]|#\n]*)$/);
        if (!m) return closeAutocomplete();

        ac.items = autocompleteCandidates(m[2], m[1] === '!');
        if (!ac.items.length) return closeAutocomplete();
        ac.start = pos - m[2].length;
        ac.index = 0;
        ac.open = true;
        renderAutocomplete();
    }

    function renderAutocomplete() {
        autocompleteList.innerHTML = '';
        ac.items.forEach((item, i) => {
            const li = document.createElement('li');
            li.className = 'ac-item' + (i === ac.index ? ' active' : '');
            li.innerHTML = `<span class="ac-icon">${item.icon}</span><span class="ac-label">${escapeHtml(item.label)}</span>` +
                (item.detail ? `<span class="ac-detail">${escapeHtml(item.detail)}</span>` : '');
            // mousedown + preventDefault: o editor não perde o foco.
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                ac.index = i;
                acceptAutocomplete();
            });
            autocompleteList.appendChild(li);
        });
        autocompleteList.classList.remove('hidden');
        positionAutocomplete();
    }

    function positionAutocomplete() {
        const c = caretCoords(ac.start);
        const maxLeft = editorPane.clientWidth - autocompleteList.offsetWidth - 8;
        autocompleteList.style.left = `${Math.max(8, Math.min(editor.offsetLeft + c.left, maxLeft))}px`;
        autocompleteList.style.top = `${editor.offsetTop + c.top + c.height + 4}px`;
    }

    function closeAutocomplete() {
        ac.open = false;
        autocompleteList.classList.add('hidden');
    }

    function acceptAutocomplete() {
        const item = ac.items[ac.index];
        if (!item) return closeAutocomplete();
        const pos = editor.selectionStart;
        const hasClose = editor.value.slice(pos, pos + 2) === ']]';
        editEditor(ac.start, pos, item.insert + (hasClose ? '' : ']]'));
        const caret = ac.start + item.insert.length + 2;
        editor.setSelectionRange(caret, caret);
        closeAutocomplete();
    }

    // Registrado antes dos outros keydown do editor e em captura: Enter/Tab
    // escolhem a sugestão em vez de continuar listas ou indentar.
    editor.addEventListener('keydown', (e) => {
        if (!ac.open) return;
        if (e.key === 'ArrowDown') {
            ac.index = (ac.index + 1) % ac.items.length;
            renderAutocomplete();
        } else if (e.key === 'ArrowUp') {
            ac.index = (ac.index - 1 + ac.items.length) % ac.items.length;
            renderAutocomplete();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            acceptAutocomplete();
        } else if (e.key === 'Escape') {
            closeAutocomplete();
        } else {
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    editor.addEventListener('blur', closeAutocomplete);
    editor.addEventListener('click', () => { if (ac.open) updateAutocomplete(); });

    // ── Keyboard Shortcuts ─────────────────────────────

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            switch (e.key.toLowerCase()) {
                case 's':
                    e.preventDefault();
                    if (currentFileHandle) saveCurrentFile();
                    break;
                case 'b':
                    if (document.activeElement !== editor) break;
                    e.preventDefault();
                    insertFormatting('bold');
                    break;
                case 'i':
                    if (document.activeElement !== editor) break;
                    e.preventDefault();
                    insertFormatting('italic');
                    break;
                case 'p':
                case 'o':
                    if (!dirHandle) break;
                    e.preventDefault();
                    openSwitcher();
                    break;
            }
        }
    });

    // ── Tab Support in Editor ──────────────────────────
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const text = editor.value;

            const lineStart = text.lastIndexOf('\n', start - 1) + 1;
            const lineEnd = text.indexOf('\n', start);
            const lineEndActual = lineEnd === -1 ? text.length : lineEnd;
            const currentLine = text.substring(lineStart, lineEndActual);

            const isListLine = !isInFence(text, start) && /^\s*(\d+\.\s|[-*+]\s)/.test(currentLine);

            if (e.shiftKey) {
                // Shift+Tab: remove até 2 espaços do início da linha
                const spacesToRemove = currentLine.match(/^( {1,2})/);
                if (spacesToRemove) {
                    const removeCount = spacesToRemove[1].length;
                    editEditor(lineStart, lineStart + removeCount, '');
                    const pos = Math.max(lineStart, start - removeCount);
                    editor.setSelectionRange(pos, pos);
                }
            } else if (isListLine) {
                // Tab em linha de lista: indentar no início da linha
                editEditor(lineStart, lineStart, '  ');
                editor.setSelectionRange(start + 2, start + 2);
            } else {
                // Tab normal: inserir 2 espaços na posição do cursor
                editEditor(start, end, '  ');
            }
        }
    });

    // ── List Auto-Continue on Enter ──────────────────
    editor.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

        const start = editor.selectionStart;
        const text = editor.value;
        if (isInFence(text, start)) return;

        // Encontrar a linha atual
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const currentLine = text.substring(lineStart, start);

        // Verificar lista ordenada: espaços opcionais + número + ". " + conteúdo
        const olMatch = currentLine.match(/^(\s*)(\d+)\.\s(.*)$/);
        // Verificar lista não-ordenada (com ou sem tarefa): "- ", "- [ ] "
        const ulMatch = currentLine.match(/^(\s*)([-*+])\s(\[[ xX]\]\s)?(.*)$/);

        if (olMatch) {
            e.preventDefault();
            const [, indent, numStr, content] = olMatch;
            if (content.trim() === '') {
                // Item vazio — remover prefixo (parar a lista)
                const prefixLen = indent.length + numStr.length + 2;
                editEditor(lineStart, lineStart + prefixLen, '');
            } else {
                // Continuar numeração
                const nextNum = parseInt(numStr, 10) + 1;
                editEditor(start, start, `\n${indent}${nextNum}. `);
            }
            return;
        }

        if (ulMatch) {
            e.preventDefault();
            const [, indent, bullet, task, content] = ulMatch;
            if (content.trim() === '') {
                // Item vazio — remover prefixo (parar a lista)
                const prefixLen = indent.length + 2 + (task ? task.length : 0);
                editEditor(lineStart, lineStart + prefixLen, '');
            } else {
                // Continuar com o mesmo marcador (e checkbox vazio, se for tarefa)
                editEditor(start, start, `\n${indent}${bullet} ${task ? '[ ] ' : ''}`);
            }
        }
    });

    // ── Event Listeners ────────────────────────────────

    // Open folder
    btnOpenFolder.addEventListener('click', openDirectory);
    btnWelcomeOpen.addEventListener('click', openDirectory);

    // Editor input
    editor.addEventListener('input', () => {
        // Renumerar listas ordenadas automaticamente
        applyRenumber();
        invalidateScrollMap();
        schedulePreview();
        scheduleAutoSave();
        updateAutocomplete();
    });

    // Links in preview
    preview.addEventListener('click', (e) => {
        const wikilink = e.target.closest('[data-wikilink]');
        if (wikilink) {
            e.preventDefault();
            openWikilink(wikilink.getAttribute('data-wikilink'));
            return;
        }
        const anchor = e.target.closest('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        // Nenhum link pode navegar a página do editor para fora.
        e.preventDefault();
        if (href.startsWith('#')) {
            let target = href.slice(1);
            try { target = decodeURIComponent(target); } catch (_) { /* keep raw */ }
            scrollPreviewToHeading(target);
        } else if (/^(https?:|mailto:)/i.test(href)) {
            window.open(href, '_blank', 'noopener');
        } else {
            // Link relativo para outra nota: [texto](outra-nota.md#secao)
            const [pathPart, hash] = href.split('#');
            let rel = pathPart;
            try { rel = decodeURIComponent(pathPart); } catch (_) { /* keep raw */ }
            const path = resolveRelativePath(dirOf(currentFileName), rel);
            if (fileHandleMap[path]) {
                openFileByPath(path, fileHandleMap[path]).then(() => { if (hash) scrollPreviewToHeading(hash); });
            }
        }
    });

    // Task checkboxes in preview
    preview.addEventListener('change', (e) => {
        const box = e.target.closest('input[data-task]');
        if (!box) return;
        const offsets = findTaskOffsets(editor.value);
        const total = preview.querySelectorAll('input[data-task]').length;
        const index = +box.dataset.task;
        if (offsets.length !== total || index >= offsets.length) {
            // Texto e preview fora de sincronia: não arrisca marcar a linha errada.
            box.checked = !box.checked;
            return;
        }
        const at = offsets[index];
        editEditor(at, at + 1, box.checked ? 'x' : ' ', true);
    });

    async function openWikilink(target) {
        const { note, heading } = parseLinkTarget(target);
        const path = resolveNotePath(note);
        if (path) {
            if (path !== currentFileName) await openFileByPath(path, fileHandleMap[path]);
            if (heading) scrollPreviewToHeading(heading);
            return;
        }
        // Target doesn't exist — offer to create
        if (dirHandle && confirm(`"${note}" não existe. Criar este arquivo?`)) {
            createFile(note);
        }
    }

    // Toolbar buttons
    document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            insertFormatting(btn.dataset.action);
        });
    });

    // New file / new folder modal
    let modalMode = 'file';

    function openCreateModal(mode) {
        if (!dirHandle) {
            openDirectory();
            return;
        }
        modalMode = mode;
        modalTitle.textContent = mode === 'file' ? 'Novo Arquivo' : 'Nova Pasta';
        newFileInput.placeholder = mode === 'file' ? 'nome-do-arquivo.md' : 'nome-da-pasta';
        modalLocation.textContent = `Em: ${selectedFolderPath || '(raiz)'}`;
        newFileInput.value = '';
        modalOverlay.classList.remove('hidden');
        setTimeout(() => newFileInput.focus(), 100);
    }

    btnNewFile.addEventListener('click', () => openCreateModal('file'));
    btnNewFolder.addEventListener('click', () => openCreateModal('folder'));
    btnDailyNote.addEventListener('click', openDailyNote);
    $('#btn-select-root').addEventListener('click', () => selectFolder(''));

    // Pede um nome no mesmo modal e devolve o texto (ou null se cancelar).
    let promptResolve = null;

    function promptName(title, location, placeholder) {
        if (promptResolve) promptResolve(null);
        modalMode = 'prompt';
        modalTitle.textContent = title;
        modalLocation.textContent = location;
        newFileInput.placeholder = placeholder || '';
        newFileInput.value = '';
        modalOverlay.classList.remove('hidden');
        setTimeout(() => newFileInput.focus(), 100);
        return new Promise((resolve) => { promptResolve = resolve; });
    }

    function settlePrompt(value) {
        if (!promptResolve) return;
        const resolve = promptResolve;
        promptResolve = null;
        resolve(value);
    }

    modalCancel.addEventListener('click', () => {
        modalOverlay.classList.add('hidden');
        settlePrompt(null);
    });

    modalCreate.addEventListener('click', () => {
        const name = newFileInput.value.trim();
        if (!name) return;
        modalOverlay.classList.add('hidden');
        if (modalMode === 'prompt') settlePrompt(name);
        else if (modalMode === 'file') createFile(name, selectedFolderPath);
        else createFolder(name);
    });

    newFileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            modalCreate.click();
        } else if (e.key === 'Escape') {
            modalCancel.click();
        }
    });

    // Delete modal
    deleteCancel.addEventListener('click', () => {
        deleteOverlay.classList.add('hidden');
        pendingDeleteName = '';
    });

    deleteConfirm.addEventListener('click', () => {
        if (pendingDeleteName) {
            deleteFile(pendingDeleteName);
            pendingDeleteName = '';
        }
        deleteOverlay.classList.add('hidden');
    });

    // Close modals on overlay click
    for (const overlay of [modalOverlay, deleteOverlay, switcherOverlay]) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    }

    // Escape to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            modalOverlay.classList.add('hidden');
            deleteOverlay.classList.add('hidden');
            switcherOverlay.classList.add('hidden');
        }
    });

    // ── Quick Switcher (Ctrl+P / Ctrl+O) ───────────────

    const switcher = { items: [], index: 0 };

    function rememberRecent(path) {
        const key = 'recent:' + dirHandle.name;
        const recent = loadJson(key, []).filter(p => p !== path);
        recent.unshift(path);
        saveJson(key, recent.slice(0, 20));
    }

    function openSwitcher() {
        switcherInput.value = '';
        switcherInput.placeholder = mode === 'map' ? 'Buscar épico, feature ou item...' : 'Buscar nota pelo nome...';
        switcherOverlay.classList.remove('hidden');
        renderSwitcher();
        setTimeout(() => switcherInput.focus(), 0);
    }

    function renderSwitcher() {
        const query = switcherInput.value.trim();
        if (mode === 'map' && backlog) {
            switcher.items = backlog.listItems()
                .map(item => ({ ...item, score: fuzzyScore(query, `${item.id} ${item.title}`) }))
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'pt-BR', { numeric: true }))
                .slice(0, 50);
            switcher.index = 0;
            drawSwitcherList();
            return;
        }
        const paths = Object.keys(fileHandleMap);
        let items;
        if (!query) {
            const recent = loadJson('recent:' + dirHandle.name, []).filter(p => fileHandleMap[p] && p !== currentFileName);
            const rest = paths.filter(p => !recent.includes(p) && p !== currentFileName)
                .sort((a, b) => a.localeCompare(b, 'pt-BR'));
            items = [...recent, ...rest].slice(0, 50).map(path => ({ path }));
        } else {
            items = paths
                .map(path => ({ path, score: Math.max(fuzzyScore(query, noteTitle(path)) * 2, fuzzyScore(query, path)) }))
                .filter(r => r.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 50);
            const exact = paths.some(p => noteTitle(p).toLowerCase() === query.toLowerCase().replace(/\.md$/i, ''));
            if (!exact) items.push({ create: query });
        }
        switcher.items = items;
        switcher.index = 0;
        drawSwitcherList();
    }

    function drawSwitcherList() {
        switcherList.innerHTML = '';
        if (!switcher.items.length) {
            switcherList.appendChild(emptyItem(mode === 'map' ? 'Nenhum item do backlog encontrado' : 'Nenhuma nota nesta pasta'));
            return;
        }
        switcher.items.forEach((item, i) => {
            const li = document.createElement('li');
            li.className = 'switcher-item' + (i === switcher.index ? ' active' : '');
            li.innerHTML = item.type
                ? `<span class="switcher-title">${escapeHtml(item.title)}</span><span class="switcher-path">${escapeHtml(item.type)}${item.id ? ' · ' + escapeHtml(item.id) : ''}</span>`
                : item.create
                ? `<span class="switcher-title">＋ Criar nota “${escapeHtml(item.create)}”</span><span class="switcher-path">${escapeHtml(selectedFolderPath || '(raiz)')}</span>`
                : `<span class="switcher-title">${escapeHtml(noteTitle(item.path))}</span><span class="switcher-path">${escapeHtml(dirOf(item.path))}</span>`;
            li.addEventListener('click', () => {
                switcher.index = i;
                chooseSwitcherItem();
            });
            switcherList.appendChild(li);
        });
        const active = switcherList.querySelector('.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function chooseSwitcherItem() {
        const item = switcher.items[switcher.index];
        if (!item) return;
        switcherOverlay.classList.add('hidden');
        if (item.create) createFile(item.create, selectedFolderPath);
        else navigateTo(item.path);
    }

    switcherInput.addEventListener('input', renderSwitcher);
    switcherInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = switcher.items.length;
            if (!n) return;
            switcher.index = (switcher.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            drawSwitcherList();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            chooseSwitcherItem();
        }
    });

    // ── Export & Preview HTML ──────────────────────────

    // Renderiza a nota atual para um HTML independente (imagens em data URL,
    // diagramas Mermaid já em SVG, tema claro).
    async function renderForExport() {
        const tmp = document.createElement('div');
        await renderInto(tmp, editor.value, {
            interactive: false,
            dark: false,
            useDataUrl: true,
            idPrefix: '',
            basePath: currentFileName
        });
        return tmp.innerHTML;
    }

    function generateFullHtml(bodyContent) {
        const title = currentFileName ? noteTitle(currentFileName) : 'Preview';
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #ffffff;
      color: #1f2328;
      padding: 32px 88px;
      max-width: none;
      margin: 0;
      line-height: 1.7;
      font-size: 15px;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; color: #1f2328; }
    h1 { font-size: 2em; padding-bottom: 10px; border-bottom: 1px solid #d1d9e0; }
    h2 { font-size: 1.5em; padding-bottom: 8px; border-bottom: 1px solid #d1d9e0; }
    h3 { font-size: 1.25em; }
    p { margin-bottom: 16px; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; }
    code {
      background: #eff1f3; padding: 2px 6px; border-radius: 4px;
      font-family: 'JetBrains Mono', monospace; font-size: 0.9em; color: #cf222e;
    }
    pre {
      background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 8px;
      padding: 16px; overflow-x: auto; margin-bottom: 16px;
    }
    pre code { background: transparent; padding: 0; color: #1f2328; font-size: 13px; line-height: 1.6; }
    blockquote {
      border-left: 3px solid #0969da; padding: 4px 16px; margin: 0 0 16px;
      color: #59636e; background: #f6f8fa; border-radius: 0 6px 6px 0;
    }
    ul, ol { padding-left: 24px; margin-bottom: 16px; }
    li { margin-bottom: 4px; }
    hr { border: none; height: 1px; background: #d1d9e0; margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { border: 1px solid #d1d9e0; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa; font-weight: 600; }
    tr:nth-child(even) { background: #f6f8fa; }
    img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
    .mermaid-block { margin: 16px 0; display: flex; justify-content: center; }
    .mermaid-block svg { max-width: 100%; height: auto; }
    .mermaid-error { color: #cf222e; font-size: 13px; }
    input[type="checkbox"] { margin-right: 6px; accent-color: #0969da; }
    .wikilink { color: #0969da; }
    .wikilink-missing { color: #9a6700; }
    table.frontmatter { width: auto; font-size: 13px; margin-bottom: 24px; }
    table.frontmatter th, table.frontmatter td { border: none; border-bottom: 1px solid #d1d9e0; padding: 4px 16px 4px 0; background: none; }
    table.frontmatter th { color: #59636e; font-weight: 500; }
    table.frontmatter tr { background: none; }
    .fm-tag { display: inline-block; background: #ddf4ff; color: #0969da; border-radius: 10px; padding: 0 8px; font-size: 12px; }
    .callout { --c: #0969da; border-left: 3px solid var(--c); background: color-mix(in srgb, var(--c) 8%, #fff); border-radius: 0 6px 6px 0; padding: 10px 16px; margin: 0 0 16px; }
    .callout-title { font-weight: 600; color: var(--c); display: flex; gap: 8px; align-items: center; }
    .callout-content > :first-child { margin-top: 8px; }
    .callout-content > :last-child { margin-bottom: 0; }
    .callout-tip, .callout-abstract { --c: #1b7c83; }
    .callout-success { --c: #1a7f37; }
    .callout-question, .callout-warning { --c: #9a6700; }
    .callout-danger { --c: #cf222e; }
    .callout-example { --c: #8250df; }
    .callout-quote { --c: #59636e; }
    .note-embed { display: block; border-left: 3px solid #d1d9e0; padding: 4px 0 4px 16px; margin: 0 0 16px; }
    .note-embed-title { display: block; font-size: 12px; margin-bottom: 4px; }
    .note-embed-missing { color: #9a6700; font-style: italic; font-size: 13px; }
    @page { margin: 16mm 14mm; }
    @media print {
      body { padding: 0; font-size: 12pt; }
      a { color: inherit; }
      h1, h2, h3, h4, h5, h6 { break-after: avoid; }
      pre, blockquote, table, img, .mermaid-block, .callout { break-inside: avoid; }
      pre { white-space: pre-wrap; }
    }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
    }

    async function exportHtml() {
        const bodyContent = await renderForExport();
        const fullHtml = generateFullHtml(bodyContent);
        const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (currentFileName ? noteTitle(currentFileName) : 'document') + '.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async function previewHtml() {
        const bodyContent = await renderForExport();
        const fullHtml = generateFullHtml(bodyContent);
        // Abre como Blob URL (carregamento de pagina normal) em vez de
        // document.write — assim os estilos do CDN carregam de forma confiavel.
        const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        if (!win) {
            // Pop-up bloqueado: cai para download do HTML.
            URL.revokeObjectURL(url);
            return exportHtml();
        }
        // Revoga depois para nao quebrar o carregamento da nova aba.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // Imprime o mesmo HTML do export num iframe oculto. "Salvar como PDF" no
    // diálogo de impressão gera o PDF.
    async function printPdf() {
        const old = document.getElementById('print-frame');
        if (old) old.remove();
        const html = generateFullHtml(await renderForExport());
        const frame = document.createElement('iframe');
        frame.id = 'print-frame';
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.appendChild(frame);
        await new Promise((resolve) => {
            frame.onload = resolve;
            frame.srcdoc = html;
        });
        const win = frame.contentWindow;
        try { await win.document.fonts.ready; } catch (_) { /* segue sem esperar */ }
        win.addEventListener('afterprint', () => frame.remove());
        win.focus();
        win.print();
    }

    // Export / Preview / PDF buttons
    btnExportHtml.addEventListener('click', exportHtml);
    btnPreviewHtml.addEventListener('click', previewHtml);
    btnPrintPdf.addEventListener('click', printPdf);

    // ── Reopen Last Folder ─────────────────────────────

    async function initReopen() {
        if (!('indexedDB' in window)) return;
        let handle;
        try {
            handle = await idbGet('lastDir');
        } catch (_) {
            return;
        }
        if (!handle) return;
        try {
            if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
                await loadDirectory(handle);
                return;
            }
        } catch (_) { /* segue para o botão */ }
        btnWelcomeReopen.querySelector('.reopen-name').textContent = handle.name;
        btnWelcomeReopen.classList.remove('hidden');
        btnWelcomeReopen.onclick = async () => {
            try {
                // Precisa de um clique do usuário para pedir a permissão de novo.
                if (await handle.requestPermission({ mode: 'readwrite' }) === 'granted') {
                    await loadDirectory(handle);
                }
            } catch (err) {
                console.error('Erro ao reabrir pasta:', err);
                btnWelcomeReopen.classList.add('hidden');
            }
        };
    }

    // ── PWA: arquivos abertos pelo sistema (.md com duplo clique) ──

    async function openLaunchedFile(handle) {
        setMode('editor');
        if (dirHandle) {
            const parts = await dirHandle.resolve(handle);
            if (parts) {
                const path = parts.join('/');
                await openFileByPath(path, fileHandleMap[path] || handle);
                return;
            }
        }
        // Arquivo fora da pasta aberta: edita sozinho, sem índice.
        showEditor();
        await openFileByPath(handle.name, handle);
    }

    // ── Backlog Map API ────────────────────────────────
    // Interface estreita que o backlog.js usa para ler e gravar notas.

    // Grava uma nota inteira (usado para mudar o status pelo mapa).
    async function writeNote(path, text) {
        const handle = path === currentFileName ? currentFileHandle : fileHandleMap[path];
        await writeFile(handle, text);
        noteCache[path] = { modified: -1, size: -1, text, masked: null };
        indexLinks(path, text);
        if (path === currentFileName) syncEditorWithDisk(text);
        updateBacklinksPanel();
        if (backlog) backlog.onIndexChanged();
    }

    const backlogApi = {
        hasFolder: () => !!dirHandle,
        dirName: () => (dirHandle ? dirHandle.name : ''),
        listNotes: () => Object.keys(fileHandleMap),
        getText: (path) => (path === currentFileName ? editor.value : (noteCache[path] ? noteCache[path].text : null)),
        currentFile: () => currentFileName,
        selectedFolder: () => selectedFolderPath,
        openDirectory,
        openInEditor,
        setMode,
        // O mapa informa qual nota está selecionada; a moldura passa a descrevê-la.
        onMapSelection: (path) => {
            if (path === mapSelection) return;
            mapSelection = path || '';
            if (mode === 'map') refreshContext();
        },
        createFile,
        writeNote,
        promptName,
        renderInto,
        splitFrontmatter,
        parseLinkTarget,
        resolveNotePath,
        noteTitle,
        dirOf,
        escapeHtml,
        foldText,
        slugify,
        fenceMask,
        loadJson,
        saveJson
    };

    // ── Initialize ─────────────────────────────────────
    if (window.MDBacklog) backlog = window.MDBacklog.create(backlogApi);
    initResizeHandle();
    showSideTab(loadJson('sideTab', 'backlinks'));

    // Check API support
    if (!('showDirectoryPicker' in window)) {
        btnOpenFolder.disabled = true;
        btnWelcomeOpen.disabled = true;
        const warn = document.createElement('p');
        warn.style.cssText = 'color: #f85149; text-align: center; margin-top: 12px; font-size: 13px;';
        warn.textContent = '⚠ Seu navegador não suporta a File System Access API. Use Chrome ou Edge.';
        document.querySelector('.welcome-content').appendChild(warn);
    } else {
        initReopen().finally(() => {
            if ('launchQueue' in window) {
                window.launchQueue.setConsumer(async (params) => {
                    const handle = params.files && params.files[0];
                    if (handle && handle.kind === 'file') await openLaunchedFile(handle);
                });
            }
        });
    }

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* sem modo offline */ });
    }

})();
